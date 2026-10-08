# Wake word models

Put wake word models here. The default wake word is "Hey Vortex".

Each model is two files with the same base name:

- `hey_vortex.tflite`: the model itself.
- `hey_vortex.json`: its manifest (the wake phrase, probability cutoff, window size and feature settings). The manifest is needed in practice: without it the device cannot know how to run the model.

A board names its model with `custom_wake_model = hey_vortex` in `platformio.ini`. At build time `tools/model_header.py` runs `tools/gen_model_header.py` to turn the pair into a C header (the model bytes, its name, cutoff and window), which `wake/` includes. The header is a build product and is not committed.

To change the wake word: add the two files here, change `custom_wake_model`, rebuild. The model must be a microWakeWord streaming model with `feature_step_size` 10. The generator rejects a file that is not TFLite, a cutoff outside 50 to 99 and a window outside 1 to 12.
