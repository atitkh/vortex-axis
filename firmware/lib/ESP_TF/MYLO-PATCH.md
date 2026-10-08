# Vendored ESP_TF 2.0.1 (TensorFlow Lite Micro + esp-nn)

Vendored for one reason: the upstream package ships **both** a generic kernel
and an esp-nn kernel for the same seven ops. Its IDF/CMake build selects one
set; PlatformIO's LDF compiles every source it finds, so the two collide:

    multiple definition of `tflite::Register_SOFTMAX()'

PlatformIO cannot exclude individual files from a `lib_deps` library (only whole
libraries via `lib_ignore`), so the choice is made here by deleting the generic
duplicates and keeping the esp-nn ones:

    add.cc  conv.cc  depthwise_conv.cc  fully_connected.cc
    mul.cc  pooling.cc  softmax.cc

esp-nn is the point of using this port over the other registry TFLM builds —
those are the S3-optimized int8 kernels, and conv/depthwise dominate wake-word
inference. `-D ESP_NN` in platformio.ini activates the optimized paths inside
them; without it these same files fall back to the reference implementations.

To re-vendor after an upstream update: copy the package in again and re-delete
the seven files above.

## Second change: mixed designated initializers

`kernels/esp_nn/conv.cc` and `depthwise_conv.cc` initialize esp-nn structs with
designated fields followed by bare positional values:

    data_dims_t d = {.width = w, .height = h, .channels = c, 1};

That is a C extension; GCC 14 in C++17 rejects it with "either all initializer
clauses should be designated or none of them should be". 12 sites were made
all-designated (`.extra = 1`, `.channels = 0, .extra = 0`) — no behaviour
change, the values are identical. Re-apply after any upstream update.
