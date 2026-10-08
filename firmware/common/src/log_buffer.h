#pragma once

// Keeps the last stretch of the device's log in memory so it can be read over
// Wi-Fi (`http://<device>/logs`) without a cable.
//
// It sits in front of the real serial port: everything printed through it still
// goes out over USB, and every line is also kept, stamped with the uptime. Give
// it to `Client::begin` as the console, and to `Client::setLogSource`.

#include <Arduino.h>
#include <esp_heap_caps.h>

namespace axis {

class LogBuffer : public Stream {
  public:
    explicit LogBuffer(Stream &inner, size_t size = 64 * 1024) : inner_(inner), size_(size) {}

    /** Allocates the ring in PSRAM. Until then nothing is kept (serial still works). */
    bool begin() {
        if (ring_) return true;
        ring_ = (char *)heap_caps_malloc(size_, MALLOC_CAP_SPIRAM);
        return ring_ != nullptr;
    }

    size_t write(uint8_t c) override { return write(&c, 1); }

    size_t write(const uint8_t *data, size_t length) override {
        inner_.write(data, length);
        if (!ring_ || !lock_) return length;
        xSemaphoreTake(lock_, portMAX_DELAY);
        for (size_t i = 0; i < length; i++) {
            if (lineStart_ && data[i] != '\r') {
                char stamp[16];
                const uint32_t ms = millis();
                const int n = snprintf(stamp, sizeof stamp, "[%lu.%03lu] ", (unsigned long)(ms / 1000), (unsigned long)(ms % 1000));
                for (int k = 0; k < n; k++) put(stamp[k]);
                lineStart_ = false;
            }
            if (data[i] == '\r') continue;
            put((char)data[i]);
            if (data[i] == '\n') lineStart_ = true;
        }
        xSemaphoreGive(lock_);
        return length;
    }

    /** Where the next byte will be counted from: total bytes ever kept. */
    uint64_t total() const { return total_; }

    /**
     * Copies up to `max` bytes starting at absolute position `from` (see
     * `total()`). If `from` is older than what is still kept, it starts at the
     * oldest byte. Returns how many were copied and moves `from` past them.
     */
    size_t readFrom(uint64_t &from, char *out, size_t max) {
        if (!ring_) return 0;
        xSemaphoreTake(lock_, portMAX_DELAY);
        if (total_ > size_ && from < total_ - size_) from = total_ - size_;
        size_t n = 0;
        while (from < total_ && n < max) out[n++] = ring_[from++ % size_];
        xSemaphoreGive(lock_);
        return n;
    }

    /** The absolute position `bytes` before the end, or the oldest kept if there is less. */
    uint64_t tailStart(size_t bytes) const {
        const uint64_t kept = total_ < size_ ? total_ : size_;
        return total_ - (bytes < kept ? bytes : kept);
    }

    // Reading (serial commands) goes straight to the port.
    int available() override { return inner_.available(); }
    int read() override { return inner_.read(); }
    int peek() override { return inner_.peek(); }
    void flush() override { inner_.flush(); }

  private:
    void put(char c) { ring_[total_++ % size_] = c; }

    Stream &inner_;
    const size_t size_;
    char *ring_ = nullptr;
    volatile uint64_t total_ = 0;
    bool lineStart_ = true;
    SemaphoreHandle_t lock_ = xSemaphoreCreateMutex();
};

}  // namespace axis
