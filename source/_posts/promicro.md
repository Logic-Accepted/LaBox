---
title: 国产 nrf52840 Promicro 踩坑记录
cover: ../images/promicro/promicro.jpg
abbrlink: d353934d
date: 2026-11-09 22:03:17
tags:
---
去年年末买了一个淘宝常见的 nrf52840 promicro 开发板。我自己写代码，生成的 uf2 却始终都不能正常运行。我觉得应该是我的开发板选错了，于是去问了也用过这个板子的朋友，却发现他们绝大多数人都是用它做键盘/SlimeVR 追踪器主控，都有现成的预编译固件，根本不需要自己选板子。我还试了升级 bootloader，并没有什么作用。 
于是我非常狼狈的满世界找了一个可以用的示例程序，在这个示例程序之上堆放我自己的代码。后来因为种种原因，放弃了那时的想法，于是这块板子也就被搁置了。   
一年后又用到了这块板子，找 ai 狠狠的拔了个底朝天，终于发现了其中的原因。
## 这块板到底是个啥
按照 ai 研究的结果，它跑的是 Adafruit nRF52 bootloader，所以确实能用 Adafruit 的 Feather 固件；但板子的引脚定义和电源设计是克隆厂自己改的，不是官方的配置。  
### 坑1：P0.13
官方 Feather nRF52840 的映射里：

```
D25 = P0.13 = SPI MOSI
D3 = P1.15 = PIN_LED1
```
而这块国产开发板把 P0.13 改成了 3.3 V 稳压器的使能，如果按照原版写程序，只要用到默认 spi，甚至用到`LED_BUILTIN`操作led，D25就会被下拉，3v3就被关掉了。这种情况下 mcu 的工作就不可预测了。我这里一般会表现为上电没反应或者上电直接进 bootloader。
### 怎么做

`setup()` 的第一行就把 P0.13 拉高并保持，早于 `Serial.begin()`和任何 SPI/GPIO 初始化：

```cpp
#define P_PWR 13

static inline void outPin(uint32_t p) { NRF_P0->PIN_CNF[p] = 0x00000003; }
static inline void gpioSet(uint32_t p, int v) {
  if (v) NRF_P0->OUTSET = (1UL << p);
  else   NRF_P0->OUTCLR = (1UL << p);
}

void setup() {
  outPin(P_PWR);
  gpioSet(P_PWR, 1);
  delay(10);

  Serial.begin(115200);
  // 其他的内容
}
```
### 问题点

用 `LED_BUILTIN` 判断板子活没活是没用的，Feather 里它是 `P1.15`，这块板它被单独引出了。
用 `SPI` 库默认引脚会把 P0.13 拉低，关掉电源。
P0.13 不能当普通 IO 做输入或开漏输出。

## 坑2：引脚映射和 Feather 不一样
如果用 `adafruit:nrf52:feather52840` 这个库去编译，Arduino 的 `D0..D29` 就会按官方 Feather 来映射，然而这块板的映射和官方的并不一样。
### 怎么做
建议是全部对着克隆厂给的资料按 `P0.xx` / `P1.xx` 这种原始编号写和接线，自己封装 GPIO，库里所有默认的 `Dn` 都不要用了。
## 坑3：TinyUSB CDC 的 DTR
Adafruit nRF52 core 默认用 TinyUSB 实现 USB CDC。它的行为是：

主机打开串口并置 DTR 之前，`Serial` 可能一直 `false`，这个时候串口的数据可能被丢弃。只打开端口、不置 DTR，这种情况表现就是端口连接了，但一个字节都没发过来一样。  
如果用 Python 的 `pyserial` 库连接串口，要在串口 `open()` 之后再设 `dtr=True` / `rts=True`，顺序反了可能没有用。
```python
s = serial.Serial()
s.port = app_port         
s.baudrate = 115200
s.timeout = 0.3
s.open()
s.dtr = True               //<---先 open 在设置
s.rts = True
time.sleep(0.4)
s.reset_input_buffer()
```
## 关于刷机
如果想让 ai 帮忙开发，可以用 1200 波特率让开发板进入bootloader,再刷，这样就不用手动去按 rst 了:  
```
s = serial.Serial()
s.port = app_port          # PID 0x8029 的应用口
s.baudrate = 1200          # 设置 1200 的波特率
s.dtr = False              # 拉低 DTR
s.rts = False
s.open()                   
time.sleep(0.3)
s.close()
```   
这个功能依赖 TinyUSB，只要它还在跑一般就可以用。

### 开发板信息
| 项目                | 值                                                           |
| ------------------- | ------------------------------------------------------------ |
| MCU                 | nRF52840（Cortex-M4F，1 MB Flash / 256 KB RAM）              |
| 固件框架            | Adafruit nRF52 Arduino core（`adafruit:nrf52:feather52840`） |
| USB VID             | `0x239A`（Adafruit）                                         |
| 应用模式 PID        | `0x8029`                                                     |
| Bootloader 模式 PID | `0x00B3`                                                     |
| SoftDevice          | S140，`sd-req 0xB6`                                          |
| DFU device type     | `0x0052`                                                     |
| UF2 family          | `0xADA52840`                                                 |
| 串口 DFU            | `adafruit-nrfutil dfu serial --singlebank`                   |
| 进入 bootloader     | 1200 bps + 下拉 DTR 或双击复位                               |
