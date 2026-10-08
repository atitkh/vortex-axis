#include <Arduino.h>
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "features.h"


// From ESPHome micro_wake_word/preprocessor_settings.h — "These must match the
// settings used when training a particular model. All microWakeWord models have
// been trained with these specific parameters."
#define SAMPLE_RATE                     16000
#define FEATURE_DURATION_MS             30
#define FEATURE_STRIDE_MS               10     // == manifest feature_step_size
#define FILTERBANK_LOWER_BAND_LIMIT     125.0f
#define FILTERBANK_UPPER_BAND_LIMIT     7500.0f
#define NOISE_REDUCTION_SMOOTHING_BITS  10
#define NOISE_REDUCTION_EVEN_SMOOTHING  0.025f
#define NOISE_REDUCTION_ODD_SMOOTHING   0.06f
#define NOISE_REDUCTION_MIN_SIGNAL_REM  0.05f
#define PCAN_ENABLE                     1
#define PCAN_STRENGTH                   0.95f
#define PCAN_OFFSET                     80.0f
#define PCAN_GAIN_BITS                  21
#define LOG_SCALE_ENABLE                1
#define LOG_SCALE_SHIFT                 6

static Print *logOut = nullptr;
static struct FrontendState state;
static bool ready = false;

bool featuresBegin(Print *log) {
    logOut = log;
    struct FrontendConfig cfg;
    FrontendFillConfigWithDefaults(&cfg);
    cfg.window.size_ms = FEATURE_DURATION_MS;
    cfg.window.step_size_ms = FEATURE_STRIDE_MS;
    cfg.filterbank.num_channels = FEATURE_SIZE;
    cfg.filterbank.lower_band_limit = FILTERBANK_LOWER_BAND_LIMIT;
    cfg.filterbank.upper_band_limit = FILTERBANK_UPPER_BAND_LIMIT;
    cfg.noise_reduction.smoothing_bits = NOISE_REDUCTION_SMOOTHING_BITS;
    cfg.noise_reduction.even_smoothing = NOISE_REDUCTION_EVEN_SMOOTHING;
    cfg.noise_reduction.odd_smoothing = NOISE_REDUCTION_ODD_SMOOTHING;
    cfg.noise_reduction.min_signal_remaining = NOISE_REDUCTION_MIN_SIGNAL_REM;
    cfg.pcan_gain_control.enable_pcan = PCAN_ENABLE;
    cfg.pcan_gain_control.strength = PCAN_STRENGTH;
    cfg.pcan_gain_control.offset = PCAN_OFFSET;
    cfg.pcan_gain_control.gain_bits = PCAN_GAIN_BITS;
    cfg.log_scale.enable_log = LOG_SCALE_ENABLE;
    cfg.log_scale.scale_shift = LOG_SCALE_SHIFT;

    if (!FrontendPopulateState(&cfg, &state, SAMPLE_RATE)) {
        if (logOut) logOut->println("[feat] FrontendPopulateState failed");
        return false;
    }
    ready = true;
    if (logOut) logOut->printf("[feat] frontend ready: %d ch, %d ms window / %d ms stride\n",
                               FEATURE_SIZE, FEATURE_DURATION_MS, FEATURE_STRIDE_MS);
    return true;
}

void featuresReset() {
    if (ready) FrontendReset(&state);
}

bool featuresProcess(const int16_t *samples, size_t count, int8_t *out) {
    if (!ready) return false;
    size_t consumed = 0;
    struct FrontendOutput o = FrontendProcessSamples(&state, (int16_t *)samples, count, &consumed);
    if (o.size == 0) return false;

    // Quantization copied verbatim from ESPHome micro_wake_word.cpp. The /25.6
    // is, in their words, "for historical reasons, to match up with the output
    // of other feature generators" — it is NOT derivable from the model's
    // quantization parameters, and getting it wrong yields a model that runs
    // and never fires.
    //   input = (((feature / 25.6) / 26.0) * 256) - 128
    // rearranged for integer math as:
    //   input = (feature * 256) / (25.6 * 26.0) - 128
    constexpr int32_t kScale = 256;
    constexpr int32_t kDiv = 666;   // 25.6 * 26.0, rounded
    for (size_t i = 0; i < o.size && i < FEATURE_SIZE; i++) {
        int32_t v = ((int32_t)o.values[i] * kScale + kDiv / 2) / kDiv;
        v += INT8_MIN;
        out[i] = (int8_t)(v < INT8_MIN ? INT8_MIN : (v > INT8_MAX ? INT8_MAX : v));
    }
    return true;
}
