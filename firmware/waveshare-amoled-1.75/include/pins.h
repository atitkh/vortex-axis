#pragma once

// Waveshare ESP32-S3-Touch-AMOLED-1.75 (round, 466 x 466)

// Display (QSPI, CO5300)
#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 38
#define LCD_CS 12
#define LCD_RESET 39
#define LCD_TE 13
#define LCD_WIDTH 466
#define LCD_HEIGHT 466

// Touch (CST9217). Its interrupt line pulses rather than staying low while a finger is down.
#define TP_INT 11
#define TP_RESET 40

// Shared I2C bus: codec, microphone ADC, IO expander, power, touch, clock, motion
#define IIC_SDA 15
#define IIC_SCL 14

// Audio: ES8311 plays, ES7210 records, on one set of I2S clocks
#define I2S_MCK_IO 42
#define I2S_BCK_IO 9
#define I2S_DI_IO 10
#define I2S_WS_IO 45
#define I2S_DO_IO 8
#define PA_ENABLE 46

// Motion sensor interrupt 2 (interrupt 1 is on the IO expander)
#define IMU_INT2 21

// I2C addresses
#define ADDR_ES8311 0x18
#define ADDR_IO_EXPANDER 0x20
#define ADDR_PMIC 0x34
#define ADDR_ES7210 0x40
#define ADDR_RTC 0x51
#define ADDR_TOUCH_CST9217 0x5A
#define ADDR_IMU 0x6B
