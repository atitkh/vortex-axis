#include "detector.h"

#include <esp_heap_caps.h>
#include <new>

#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include "features.h"
// Generated at build time by tools/gen_model_header.py: the model array plus
// WW_BUILTIN_NAME / WW_BUILTIN_CUTOFF_PCT / WW_BUILTIN_WINDOW.
#include "model_builtin.h"

namespace wake {

namespace {

// The arena search starts just above what the model needs and grows, so the
// scarce internal RAM is not spent on room the model never uses.
const size_t ARENA_MIN = 28672;
const size_t ARENA_STEP = 4096;
// Internal RAM left for the rest of the firmware (Wi-Fi, sockets, tasks).
const size_t ARENA_RESERVE = 40960;
const size_t ARENA_HARD_MAX = 131072;
const int WINDOW_MAX = 12;
const int RESOURCE_VARIABLES = 16;
// The model takes three feature slices per inference.
const int SLICES = 3;

Print *logOut = nullptr;
uint8_t *arena = nullptr;
tflite::MicroInterpreter *interp = nullptr;
TfLiteTensor *inTensor = nullptr, *outTensor = nullptr;
bool isReady = false;
uint32_t arenaBytes = 0, lastUs = 0, hits = 0;
uint8_t sensitivity = 0, peak = 0;

int windowLen = WW_BUILTIN_WINDOW;
float window[WINDOW_MAX];
int windowIdx = 0;
bool latched = false;

int8_t slices[SLICES][FEATURE_SIZE];
int sliceCount = 0;

float cutoff() {
    const uint8_t pct = sensitivity >= 50 && sensitivity <= 99 ? sensitivity : WW_BUILTIN_CUTOFF_PCT;
    return pct / 100.0f;
}

void say(const char *what) {
    if (logOut) logOut->printf("[wake] %s\n", what);
}

/** The feature path hands the model a fixed [1,3,40] int8 block and copies exactly 120 bytes in. */
bool shapeIsCompatible(TfLiteTensor *in, TfLiteTensor *out) {
    if (!in || !out) return false;
    if (in->type != kTfLiteInt8 || out->type != kTfLiteUInt8) return false;
    if (in->dims->size != 3) return false;
    return in->dims->data[0] == 1 && in->dims->data[1] == SLICES && in->dims->data[2] == FEATURE_SIZE;
}

bool load() {
    const tflite::Model *model = tflite::GetModel(ww_builtin_model);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        if (logOut) logOut->printf("[wake] model schema %lu, expected %d\n", (unsigned long)model->version(), TFLITE_SCHEMA_VERSION);
        return false;
    }

    // Exactly the ops this model uses. TFLM wants each registered by hand, and a missing one only shows up in AllocateTensors.
    static tflite::MicroMutableOpResolver<13> resolver;
    resolver.AddCallOnce();
    resolver.AddVarHandle();
    resolver.AddReadVariable();
    resolver.AddAssignVariable();
    resolver.AddReshape();
    resolver.AddConcatenation();
    resolver.AddStridedSlice();
    resolver.AddConv2D();
    resolver.AddDepthwiseConv2D();
    resolver.AddSplitV();
    resolver.AddFullyConnected();
    resolver.AddLogistic();
    resolver.AddQuantize();

    // One allocator over one arena, shared by the resource variables and the
    // interpreter. The allocator lives inside the arena, so a retry frees the
    // arena and rebuilds everything, hence the placement new.
    alignas(8) static uint8_t interpStorage[sizeof(tflite::MicroInterpreter)];
    size_t arenaMax = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    arenaMax = arenaMax > ARENA_RESERVE ? arenaMax - ARENA_RESERVE : 0;
    if (arenaMax > ARENA_HARD_MAX) arenaMax = ARENA_HARD_MAX;
    if (arenaMax < ARENA_MIN) arenaMax = ARENA_MIN;

    bool allocated = false;
    for (size_t size = ARENA_MIN; size <= arenaMax; size += ARENA_STEP) {
        arena = (uint8_t *)heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (!arena) {
            if (logOut) logOut->printf("[wake] no internal RAM for a %u byte arena\n", (unsigned)size);
            break;  // a bigger one will not fit either
        }
        tflite::MicroAllocator *alloc = tflite::MicroAllocator::Create(arena, size);
        if (alloc) {
            tflite::MicroResourceVariables *vars = tflite::MicroResourceVariables::Create(alloc, RESOURCE_VARIABLES);
            interp = new (interpStorage) tflite::MicroInterpreter(model, resolver, alloc, vars);
            if (interp->AllocateTensors() == kTfLiteOk) {
                arenaBytes = size;
                allocated = true;
                break;
            }
        }
        heap_caps_free(arena);
        arena = nullptr;
        interp = nullptr;
    }
    if (!allocated) {
        if (logOut) logOut->printf("[wake] the model needs more than the %u bytes of arena available\n", (unsigned)arenaMax);
        return false;
    }

    inTensor = interp->input(0);
    outTensor = interp->output(0);
    if (!shapeIsCompatible(inTensor, outTensor)) {
        say("model has the wrong input shape, need 1x3x40 int8");
        heap_caps_free(arena);
        arena = nullptr;
        interp = nullptr;
        return false;
    }
    if (WW_BUILTIN_WINDOW >= 1 && WW_BUILTIN_WINDOW <= WINDOW_MAX) windowLen = WW_BUILTIN_WINDOW;
    if (logOut) {
        logOut->printf("[wake] \"%s\" loaded, cutoff %u%%, window %d, arena %u of %u bytes\n", WW_BUILTIN_NAME,
                       (unsigned)WW_BUILTIN_CUTOFF_PCT, windowLen, (unsigned)interp->arena_used_bytes(), (unsigned)arenaBytes);
    }
    return true;
}

/** One inference over the three slices; -1 on failure. uint8 output with scale 1/256. */
float infer() {
    memcpy(inTensor->data.int8, &slices[0][0], SLICES * FEATURE_SIZE);
    const uint32_t t0 = micros();
    if (interp->Invoke() != kTfLiteOk) return -1.0f;
    lastUs = micros() - t0;
    return outTensor->data.uint8[0] / 256.0f;
}

/** Averages the last few answers. Needs a clear drop before it can fire again, or one phrase would trigger repeatedly as the average decays. */
bool accept(float p, float *score) {
    if (p < 0) return false;
    window[windowIdx] = p;
    windowIdx = (windowIdx + 1) % windowLen;
    float sum = 0;
    for (int i = 0; i < windowLen; i++) sum += window[i];
    const float average = sum / windowLen;
    if (score) *score = average;
    const uint8_t pct = (uint8_t)(average * 100.0f);
    if (pct > peak) peak = pct;

    if (!latched && average >= cutoff()) {
        latched = true;
        hits++;
        return true;
    }
    if (latched && average < cutoff() * 0.6f) latched = false;
    return false;
}

}  // namespace

bool begin(Print *log) {
    logOut = log;
    if (isReady) return true;
    if (!featuresBegin(log)) return false;
    isReady = load();
    return isReady;
}

bool ready() { return isReady; }

bool feed(const int16_t *samples, size_t count, float *score) {
    if (!isReady) return false;
    // The frontend consumes whole 10 ms steps and says when a slice is ready.
    // It may take several calls to produce one, so hand it exactly what it asks for.
    bool fired = false;
    size_t offset = 0;
    while (offset < count) {
        // 160 samples is one step; the frontend reports a slice per step once it has filled its 30 ms window.
        const size_t chunk = min((size_t)160, count - offset);
        if (featuresProcess(samples + offset, chunk, slices[sliceCount])) {
            if (++sliceCount == SLICES) {
                sliceCount = 0;
                if (accept(infer(), score)) fired = true;
            }
        }
        offset += chunk;
    }
    return fired;
}

void setSensitivity(uint8_t percent) { sensitivity = percent; }
uint8_t cutoffPercent() { return (uint8_t)(cutoff() * 100.0f + 0.5f); }

void reset() {
    featuresReset();
    sliceCount = 0;
    windowIdx = 0;
    latched = false;
    for (int i = 0; i < WINDOW_MAX; i++) window[i] = 0;
}

const char *modelName() { return WW_BUILTIN_NAME; }
uint32_t lastInferenceUs() { return lastUs; }
uint8_t peakPercent() { return peak; }
uint32_t arenaSize() { return arenaBytes; }
uint32_t arenaUsed() { return interp ? interp->arena_used_bytes() : 0; }
uint32_t detections() { return hits; }

}  // namespace wake
