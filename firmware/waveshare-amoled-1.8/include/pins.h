#pragma once

// Waveshare ESP32-S3-Touch-AMOLED-1.8

// Display (QSPI)
#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 11
#define LCD_CS 12
#define LCD_WIDTH 368
#define LCD_HEIGHT 448

// Touch interrupt, low while a finger is down
#define TP_INT 21

// Shared I2C bus: codec, IO expander, power, touch, clock, motion
#define IIC_SDA 15
#define IIC_SCL 14

// Audio (ES8311 codec over I2S)
#define I2S_MCK_IO 16
#define I2S_BCK_IO 9
#define I2S_DI_IO 10
#define I2S_WS_IO 45
#define I2S_DO_IO 8
#define PA_ENABLE 46

// I2C addresses
#define ADDR_ES8311 0x18
#define ADDR_IO_EXPANDER 0x20
#define ADDR_PMIC 0x34
#define ADDR_TOUCH_FT3168 0x38
#define ADDR_RTC 0x51
#define ADDR_IMU 0x6B
