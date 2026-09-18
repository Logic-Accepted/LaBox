---
title: 一次延迟一个月的断网事故
abbrlink: c969c9e8
description: 一条 apt remove 命令，在三十四天后毁掉我的网络
date: 2026-09-18 18:13:05
tags:
---

> 本文为我和 Deepseek-v4.1-flash 共同撰写，仅作经验分享用。  
> 部分命令行内容是 ocr 出来的，可能有不影响理解的乱码存在。（因为 pve 控制台没法复制）

# 事发
我在软路由运行着一台 Ubuntu 24.04 的虚拟机，平时跑一些自用服务，比如有 komga 用来看漫画和一些电子书，Jellyfin 影视库，还有 DSH。

9 月 18 号晚上我发现我的 DSH 落后版本挺多了，于是登上去想着编译一个新版本用。恰巧看了一眼，发现有 96 个软件包可以更新。本着来都来了的原则，就升级一下：  

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt autoremove -y
sudo reboot
```

这把下载了 700 多兆文件，`lsb_release` 从 24.04.2 变成了 24。04.5。但是在我打出最后一条命令之后 SSH 就再也连不上了。   

打开 PVE 的控制台一看, 明明 System information 还显示着正确的ip, 但是实际上并没有连上网：  

```console
$ iplink
ens18, 2:ens18:<BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN group default qlen 1000 link/etherbc:24:11:d7:5c:9abrdff:ff:ff:ff:ff:ff altname enpos18 ......
```

网卡是在，但是是 DOWN 状态。我`sudo ip link set ens18 up`手动打开：

```console
$ ip -br addr
lo      UNKNOWN   127.0.0.1/8 ::1/128
ens18   UP        fe80::be24:11ff:fed7:5c9a/64
```

一看，只有一个 IPv6 的 link-local 地址，没有 IPv4，也没有 DHCP。第一反应非常自然：升级把网卡配置弄丢了。  

![网卡爆炸了](../images/netplanoutage/wangkabaozhale.png)

# 我做的“修复”
既然配置丢了，补一个就是了。我 `sudo netplan generate --debug`，却发现根本没有 `netplan` 。甚是疑惑的我又检查了一下，确实没有
```console
brcl03@labox:^$ dpkg -l netplan.io 
Desired=Unknown/Install/Remove/Purge/Hold
| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend
|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)
Version Architecture Description 
+++-==============-======================-============-=================================================================
netplan.io <none> <none> (no description available)
```
那奇怪了，我们还有什么呢？
```console
brcl03@labox:~$ dpkg -l | grep -E 'netplan|ifupdoun|systemd-networkd|cloudinit'
ii  networkd-dispatcher    2.2.4-1     all   Dispatcher service for systemd-networkd connection status changes
```
在 GPT 的指导下，我用 systemd-networkd 手动恢复 DHCP, 写如下 systemd-networkd 的原生配置：  

```ini
[Match]
Name=ens18

[Network]
DHCP=yes
```

存成 `/etc/systemd/network/10-ens18.network`，重启 networkd，网络立刻就回来了，v4 v6 地址都拿到了：  

```console
$ systemctl restart systemd-networkd
$ ip -br addr show ens18
ens18  UP  192.168.233.118/24 fdbd:3a89:5839::cc2/128 fe80::be24:11ff:fed7:5c9a/64
```

那一刻我的心态是：“这升级居然能把网卡配置弄没，还好没太费力就补回来了。”  

然而这个判断是错的。  

# 复盘：netplan 的配置为什么没生效
在这之前我并不知道 Ubuntu 上的 netplan 其实是两个东西：  

1. `netplan.io`：提供 `netplan` 这个命令行工具，也就是平时敲的 `netplan apply`。  
2. `netplan-generator`：一个 systemd 的启动生成器。开机时 systemd 会执行它，把 `/etc/netplan/*.yaml` 翻译成 `/run/systemd/network/*.network`，再交给 systemd-networkd。  

也就是说，真正让 yaml 的配置文件生效的是 `generator`，而不是那个 CLI。CLI 只是给人改配置的时候用的。  



开机时 generator 为什么没去转换 yaml 呢？因为开机时根本没有 generator:  

```console
$ dpkg -l netplan.io netplan-generator libnetplan1 python3-netplan
ii  libnetplan1        1.1.2-8ubuntu1~24.04.3
ii  netplan-generator  1.1.2-8ubuntu1~24.04.3
ii  netplan.io         1.1.2-8ubuntu1~24.04.3
ii  python3-netplan    1.1.2-8ubuntu1~24.04.3
```

四个包全是 09:45 才在系统里的(因为我自己 `apt install --reinstall netplan.io` 了一遍)。也就是说在这之前，它们根本不在。  

到这里更让人疑惑了：netplan 为什么会更新没呢？

# 凶手是 34 天前的一条命令
去翻 `/var/log/apt/history.log.1.gz`，找到了 8 月 15 号的一条记录：  

```
Start-Date: 2026-08-15  02:24:20
Commandline: apt-get remove build-essential autoconf automake libtool pkg-config \
  libnl-3-dev libnl-genl-3-dev libssl-dev ethtool shtool rfkill zlib1g-dev \
  libpcap-dev libsqlite3-dev libpcre2-dev libhwloc-dev libcmocka-dev hostapd \
  wpasupplicant tcpdump screen iw usbutils expect
Requested-By: brcl03 (1000)
```

看着人畜无害，就是“把之前编译东西时装的一堆依赖清掉”。但 `apt remove` 实际上会连带删除所有的反向依赖。这条命令实际删掉的包，比上面列出来的多得多：  

- `ethtool`，我显式指定的那个；  
- `netplan.io`，因为 `Depends: ethtool`；  
- `cloud-init`，因为 `Depends: netplan.io`；  
- `ubuntu-minimal`，同样因为 `Depends: netplan.io`；  
- `ubuntu-server-minimal`，因为 `Depends: ubuntu-minimal`；  
- `ubuntu-server`、`ubuntu-standard`：层层往上，全都没了。  

一条“清编译依赖”的命令，顺手把我的网络配置包和三个 ubuntu 元包一起端掉了。  所以说，并不是更新把 netplan 更没了，而是一个多月前就已经被我删掉了。

那为什么当时没断网？因为 `netplan-generator` 还在。它只是被顺手升了个级，照样在开机时把 `50-cloud-init.yaml` 翻译成 `.network` 文件。如前文所述，`netplan.io` 只是个 CLI，没了它并不影响开机和配置文件转换。于是这颗雷就这么安安静静地埋了 34 天。  

# autoremove 补上最后一刀
9 月 18 号 09:13:21，也就是 `apt upgrade` 升级结束之后一分钟，我跑了 `apt autoremove`。  

`autoremove` 的职责是清理“曾经被自动装进来、现在不再需要”的包。而 `netplan.io` 既然已经不在系统里，`netplan-generator`、`libnetplan1`、`python3-netplan` 这三个就正好符合“没人需要”的定义。于是：  

```
2026-09-18 09:13:26 remove netplan-generator:amd64 1.1.2-8ubuntu1~24.04.2
2026-09-18 09:13:26 remove python3-netplan:amd64    1.1.2-8ubuntu1~24.04.2
2026-09-18 09:13:26 remove libnetplan1:amd64        1.1.2-8ubuntu1~24.04.2
```

这里就把 `netplan-generator` 给删掉了，紧接着重启里自然就没办法去生成配置文件了。
完整时间线如下：  

```
2026-08-15 02:24:20  apt-get remove ... ethtool ...   连带删掉 netplan.io 和三个 ubuntu 元包
                     (netplan-generator 幸存，网络照旧)
2026-09-18 09:04:40  apt upgrade                       升级到 24.04.5
2026-09-18 09:13:21  apt autoremove                    把失去主人的 netplan-generator 清掉
2026-09-18 09:14     reboot
2026-09-18 09:15:01  systemd-networkd 启动，ens18 无匹配配置， unmanaged
2026-09-18 09:17:02  systemd-networkd-wait-online 超时失败
2026-09-18 09:27:09  ens18 才 Gained carrier(手动 set up)
2026-09-18 09:43     手写 /etc/systemd/network/10-ens18.network → 恢复
2026-09-18 09:45:01  apt install --reinstall netplan.io
```

所以真相并非升级弄丢了配置，而是我在一个月前就把用来翻译配置的那个程序删了，一个月后的 autoremove 帮我把最后一环也收拾干净了。  

# 然后我又给自己挖了第二个坑
网络是回来了，但我手写配置本身只是临时举措，留了个隐患。  

现在 `ens18` 同时匹配两个文件：  

```
/etc/systemd/network/10-ens18.network          ← 我手写的
/run/systemd/network/10-netplan-ens18.network  ← netplan 生成的
```

systemd-networkd 对 `.network` 文件只采用排序最靠前的那一个匹配项，按文件名比较：`10-ens18…` < `10-netplan…`(`e` 排在 `n` 前面)，所以我手写的那个胜出，netplan 生成的配置被忽略了。  

这一点光看 networkd 的日志是看不出来的，得用 netplan 自己的视角：  

```console
$ netplan status
●  2: ens18 ethernet UP (unmanaged)
```

`unmanaged`。也就是说从现在开始，我改 `/etc/netplan/*.yaml`、跑 `netplan apply`、`netplan try`，全都没有任何效果。哪天我忘了这件事去改 YAML，大概率会再写一篇和这篇一模一样的文章（x）。  

正确做法是把两套配置二选一。要么删掉手写文件回到 netplan，要么干脆不用 netplan，我都把它装回来了，所以我选前者：  

```bash
sudo rm /etc/systemd/network/10-ens18.network
sudo netplan apply && network status ens18
```
看起来一切正常，不错。
  

# 顺带发现的其他问题
解决这些之后，让在这台机器上跑的 dsh 帮我顺手做了个体检，发现的问题还真不少。  

1. ubuntu 元包全没了。上面那条命令连带删掉了 `ubuntu-minimal`、`ubuntu-standard`、`ubuntu-server-minimal`、`ubuntu-server`，而且连配置残留(`rc` 状态)都没有，是彻底不在了。这几个包本身不占空间、也不提供任何功能，但它们是“以后 Ubuntu 往默认依赖里加东西”的入口。少了它们，这台机器会慢慢漂移成一个和标准服务器不一样的东西，而且还不会有任何报错。  
2. 七十多个 `rc` 状态的残留包。`dpkg -l | awk '$1=="rc"'` 一拉一大片，从 `6.8.0-56` 到 `6.8.0-137` 的历代内核、`linux-modules-*`、`jellyfin-ffmpeg7`、`cloud-init` 全在里面，都是没有软件包却留着配置文件。  
3. `slirp4netns` 和 `libslirp0` 也被 autoremove 带走了。这俩是 rootless 容器联网要用的，而我装了 `docker-ce-rootless-extras`。目前跑的是 rootful，确实没影响，但哪天想用 rootless 就会发现莫名其妙不通。  
4. 根分区 82%。确实是我的硬盘太小了，但现在硬盘也太贵了，但但我还是一怒之下把 200M 的 journal 清了一下（x）。  
5. `/etc` 里的升级垃圾。`/etc/default/grub.ucf-dist` 和 `/etc/ca-certificates.conf.dpkg-old`。前者 dsh diff 过，跟当前的 `/etc/default/grub` 一字不差，dsh 说：纯垃圾。   
 

# 小结
这次事故里我没犯了不少常识性的错误：  

1. `apt remove` 会级联删除反向依赖。删任何东西之前，先 `apt remove -s <包>` 干跑一遍，看它到底要动哪些包。这条命令我以前一直懒得敲，现在觉得它是最划算的一秒钟。 <--现在也懒得敲，dsh说划算以后让dsh帮我敲。 
2. 不要删 ubuntu 元包。它们不占地方，但代表了“系统默认应该有什么”。  
3. `apt autoremove` 只是执行者，不是元凶。它删的每一个包，都是在更早的操作里就已经失去主人的。这次真正该死的是 8 月 15 号那条 remove。  
4. 同一时刻只保留一套网络配置。netplan 和 systemd-networkd 原生配置混用不会报错，只会失效，比直接报错难查得多。判断方法也很简单：`netplan status` 看接口是不是 `unmanaged`，`networkctl status <网卡>` 看 `Network File` 指向哪个文件。  
5. 升级之后花一分钟体检。`systemctl --failed`、`dpkg -C`、`dpkg -l | awk '$1=="rc"'`，再加上 `/etc` 下的 `*.dpkg-old` 和 `*.ucf-dist`，这几个命令基本能捞出大部分问题。  
6. 动手改网络之前，先想好怎么进去。对一台只有网线、没有带外管理的虚拟机来说，Proxmox 的控制台就是最后一根救命稻草，别只留一条 SSH。  

本次事故真正让我觉得意外的点其实是这台机器上真正被升级更坏的东西，其实是一点都没有。问题全都源自一个月前的 apt remove。  
