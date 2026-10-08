# axis-wake

The wake word detector, with no board in it: 16 kHz mono samples in, "heard it" out.

- `src/features.*` turns audio into 40 int8 features per 10 ms with the TFLite Micro audio frontend, using microWakeWord's exact training settings. They are not tunable; a model trained against these values will run happily against anything else and never fire.
- `src/detector.*` loads the streaming model, runs it every third slice, averages the last few answers and compares them with the cutoff. After a hit it stays quiet until the score has clearly dropped.
- The model is not in this folder. It comes from `../models` through a header generated at build time (see `../models/README.md`).

Both source files started as Mylo's `features.cpp` and `wakeword.cpp`; the upload-a-model-to-flash code and the Mylo config dependency were removed.
