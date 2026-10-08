#pragma once
#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>

// Audio -> 40 int8 features per 10 ms slice, using the TFLM microfrontend with
// microWakeWord's exact training settings. Every constant here is copied from
// ESPHome's preprocessor_settings.h; they are not tunable, because the model
// was trained against these values.
#define FEATURE_SIZE 40

bool featuresBegin(Print *log = nullptr);

// Feeds mono 16 kHz samples. When a full 10 ms slice completes, writes 40 int8
// features to `out` and returns true. May return false for several calls while
// the frontend accumulates its 30 ms window.
bool featuresProcess(const int16_t *samples, size_t count, int8_t *out);

void featuresReset();
