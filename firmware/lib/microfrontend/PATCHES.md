# Vendored TFLM microfrontend

Source: tensorflow/tflite-micro, `tensorflow/lite/experimental/microfrontend/lib`.

Vendored because neither TFLM port in the PlatformIO registry includes it, and
the feature pipeline is not substitutable: microWakeWord models are trained
against exactly this filterbank/noise-reduction/PCAN chain. A hand-written MFCC
with the wrong bin edges or smoothing produces a model that runs happily and
never fires.

## kissfft layout

`kiss_fft_int16.h/.cc` include kissfft **sources** inside `namespace
kissfft_fixed16` so a binary can hold several precisions at once. They expect
`kiss_fft.{c,h}` at the include root and `tools/kiss_fftr.{c,h}` beneath it, so
those five files are copied here from `lib/ESP_TF/src/kissfft/` (identical
upstream kissfft).

`library.json` excludes `kiss_fft.c` and `tools/kiss_fftr.c` from the build:
they are `#include`d into the namespaced wrapper, and compiling them standalone
would emit a second, un-namespaced copy at the wrong precision.

ESP_TF's own wrappers use `kiss_fft_fixed16`; this one uses `kissfft_fixed16`.
Different namespaces, so both can be linked.
