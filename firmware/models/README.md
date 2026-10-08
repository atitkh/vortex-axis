# Wake word models

Put wake word models here. The default wake word is "Hey Vortex".

Each model is two files with the same base name:

- `hey_vortex.tflite`: the model itself.
- `hey_vortex.json`: its manifest (the wake phrase, probability cutoff, window size and feature settings). The manifest is needed in practice: without it the device cannot know how to run the model.

The firmware will build the model named in its configuration into the device. Nothing reads this folder yet; wake word support is step 4 of the firmware build order.
