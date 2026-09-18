---
title: 一次延迟一个月的断网事故
abbrlink: c969c9e8
description: 一条 apt remove 命令，如何在三十四天后炸掉我的网络
date: 2026-09-18 18:13:05
tags:
---

> 本文仅作经验分享用，不建议读者将之视为教程学习。  
> 本文依照我自身的认知而作，描述方面可能出现错漏，敬请见谅。  
> 感谢 netplan 与 systemd 的开发者们，虽然这回是他们把我坑了，但锅主要还是在我。  

# 事发
labox 是我放在 Proxmox 上的一台 Ubuntu 24.04 虚拟机，平时跑一些自用服务：nginx、Jellyfin，还有几个容器。它对我来说属于“装完就不该管”的那种机器，唯一的入口就是 SSH。  

9 月 18 号早上我久违地登上去看了一眼，发现 `apt list --upgradable` 里躺了 96 个包。想着“来都来了”，就按老一套把升级跑了：  

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt autoremove -y
sudo reboot
```

前面几条跑得顺顺当当，`lsb_release` 从 24.04.2 变成了 24.04.5，于是我就去干别的事了。回来之后 SSH 连不上。  

> 这里得先交代一下我的心态：我一直觉得自己对这台机器的网络配置是心里有数的，`/etc/netplan/` 里就一个 `50-cloud-init.yaml`，DHCP 拿地址，简单得不能再简单。  

打开 Proxmox 的控制台一看：  

```console
$ ip -br addr
lo      UNKNOWN   127.0.0.1/8 ::1/128
ens18   UP        fe80::be24:11ff:fed7:5c9a/64
```

网卡还在，链路也是 UP，但只有一个 IPv6 的 link-local 地址，没有 IPv4，也没有 DHCP。第一反应非常自然：升级把网卡配置弄丢了。  

<!-- 这里可以放 Proxmox 控制台的截图：../images/netplanoutage/console.png -->

# 我做的“修复”
既然配置丢了，补一个就是了。当时我的思路是干脆绕过 netplan，直接写 systemd-networkd 的原生配置：  

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

那一刻我的心态是：“果然是升级把配置弄没了，补回来就行。”  

这个判断是错的。  

# 复盘：netplan 的配置为什么没生效
先补一个我原本只知道一半的常识。Ubuntu 上的 netplan 其实是两个东西：  

1. `netplan.io`：提供 `netplan` 这个命令行工具，也就是平时敲的 `netplan apply`。  
2. `netplan-generator`：一个 systemd 的启动生成器。开机时 systemd 会执行它，把 `/etc/netplan/*.yaml` 翻译成 `/run/systemd/network/*.network`，再交给 systemd-networkd。  

也就是说，真正让 YAML 生效的是 generator，而不是那个 CLI。CLI 只是给人手动触发用的。  

顺着这条线去看，问题就出来了：  

```console
$ ls -la /run/systemd/network/
total 4
drwxr-xr-x 2 root root  60 Sep 18 09:47 .
drwxr-xr-x 24 root root 620 Sep 18 09:47 ..
-rw-r----- 1 root root 101 Sep 18 09:47 10-netplan-ens18.network
```

这个文件的时间是 09:47，比我手写 `10-ens18.network` 的 09:43 还晚。而在它出现之前，这个目录是空的。空目录意味着：开机时没有任何 `.network` 文件匹配 `ens18`，systemd-networkd 于是把它当成 `unmanaged`，什么都不做。链路 UP、有 link-local、没有 DHCP，和我看到的现象完全吻合。  

那 generator 为什么没跑？查包就明白了：  

```console
$ dpkg -l netplan.io netplan-generator libnetplan1 python3-netplan
ii  libnetplan1        1.1.2-8ubuntu1~24.04.3
ii  netplan-generator  1.1.2-8ubuntu1~24.04.3
ii  netplan.io         1.1.2-8ubuntu1~24.04.3
ii  python3-netplan    1.1.2-8ubuntu1~24.04.3
```

四个包全是 09:45 才在系统里的(因为我自己 `apt install --reinstall netplan.io` 了一遍)。也就是说在这之前，它们根本不在。  

到这里逻辑算是串起来了，但我还有一个想不通的地方：如果 netplan 早就不在了，那 8 月中旬到 9 月 18 号之间，这台机器的网络为什么一直是好的？  

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

看着人畜无害，就是“把之前编译东西时装的一堆依赖清掉”。但 `apt remove` 有一个我一直知道、却从来没有真正重视过的行为：它会连带删除所有的反向依赖。这条命令实际删掉的包，比上面列出来的多得多：  

- `ethtool`，我显式指定的那个；  
- `netplan.io`，因为 `Depends: ethtool`；  
- `cloud-init`，因为 `Depends: netplan.io`；  
- `ubuntu-minimal`，同样因为 `Depends: netplan.io`；  
- `ubuntu-server-minimal`，因为 `Depends: ubuntu-minimal`；  
- `ubuntu-server`、`ubuntu-standard`：层层往上，全都没了。  

一条“清编译依赖”的命令，顺手把我的网络配置包和三个 ubuntu 元包一起端掉了。  

那为什么当时没断网？因为 `netplan-generator` 还在。它只是被顺手升了个级，照样在开机时把 `50-cloud-init.yaml` 翻译成 `.network` 文件。`netplan.io` 只是个 CLI，没人敲它并不影响开机流程。于是这颗雷就这么安安静静地埋了 34 天。  

# autoremove 补上最后一刀
9 月 18 号 09:13:21，也就是 `apt upgrade` 结束之后一分钟，我跑了 `apt autoremove`。  

`autoremove` 的职责是清理“当年被自动装进来、现在没人再需要”的包。而 `netplan.io` 既然已经不在系统里，`netplan-generator`、`libnetplan1`、`python3-netplan` 这三个就正好符合“没人需要”的定义。于是：  

```
2026-09-18 09:13:26 remove netplan-generator:amd64 1.1.2-8ubuntu1~24.04.2
2026-09-18 09:13:26 remove python3-netplan:amd64    1.1.2-8ubuntu1~24.04.2
2026-09-18 09:13:26 remove libnetplan1:amd64        1.1.2-8ubuntu1~24.04.2
```

三行日志，我的网络就在紧接着的重启里没了。完整时间线整理一下：  

```
2026-08-15 02:24:20  apt-get remove ... ethtool ...   ← 连带删掉 netplan.io 和三个 ubuntu 元包
                     (netplan-generator 幸存，网络照旧)
2026-09-18 09:04:40  apt upgrade                       ← 升级到 24.04.5
2026-09-18 09:13:21  apt autoremove                    ← 把失去主人的 netplan-generator 清掉
2026-09-18 09:14     reboot
2026-09-18 09:15:01  systemd-networkd 启动，ens18 无匹配配置 → unmanaged
2026-09-18 09:17:02  systemd-networkd-wait-online 超时失败
2026-09-18 09:27:09  ens18 才 Gained carrier(链路本身也晚了 12 分钟)
2026-09-18 09:43     手写 /etc/systemd/network/10-ens18.network → 恢复
2026-09-18 09:45:01  apt install --reinstall netplan.io
```

所以真相是：**并不是升级弄丢了配置**，而是我在一个月前就把“翻译配置的那个程序”删了，一个月后的 autoremove 帮我把最后一环也收拾干净了。  

# 然后我又给自己挖了第二个坑
网络是回来了，但我这个修法本身留了个隐患。  

现在 `ens18` 同时匹配两个文件：  

```
/etc/systemd/network/10-ens18.network          ← 我手写的
/run/systemd/network/10-netplan-ens18.network  ← netplan 生成的
```

systemd-networkd 对 `.network` 文件只采用排序最靠前的那一个匹配项，按文件名比较：`10-ens18…` < `10-netplan…`(`e` 排在 `n` 前面)，所以我手写的那个胜出，netplan 生成的配置被静默忽略了。  

这一点光看 networkd 的日志是看不出来的，得用 netplan 自己的视角：  

```console
$ netplan status
●  2: ens18 ethernet UP (unmanaged)
```

`unmanaged`。也就是说从现在开始，我改 `/etc/netplan/*.yaml`、跑 `netplan apply`、`netplan try`，全都没有任何效果。哪天我忘了这件事去改 YAML，大概率会再写一篇和这篇一模一样的文章。  

正确做法是把两套配置收敛成一套。要么删掉手写文件回到 netplan，要么干脆承认自己不用 netplan，但 Ubuntu 的默认就是它，没必要对着干。我选前者：  

```bash
sudo cp /etc/systemd/network/10-ens18.network /root/   # 先留个后路
sudo rm /etc/systemd/network/10-ens18.network
sudo netplan apply
```

> 这里有个细节要注意：我手写的文件是 `DHCP=yes`，同时开了 DHCPv6，所以现在有 `fdbd:3a89:5839::cc2/128` 和一个 /62 的委派前缀。而 `50-cloud-init.yaml` 只有 64 字节，大概率只写了 `dhcp4: true`，直接切回去会丢 IPv6，得先把 `dhcp6: true` 补上。这也是我先把文件备份到 `/root` 的原因：网络配置这种东西改错了就等于把自己锁在门外，最好从 Proxmox 的控制台动手，别只留一根 SSH 线。  

# 顺带发现的其他问题
既然都登进来了，就顺手做了个体检，发现的问题比断网本身还多。  

1. ubuntu 元包全没了。上面那条命令连带删掉了 `ubuntu-minimal`、`ubuntu-standard`、`ubuntu-server-minimal`、`ubuntu-server`，而且连配置残留(`rc` 状态)都没有，是彻底不在了。这几个包本身不占空间、也不提供任何功能，但它们是“以后 Ubuntu 往默认依赖里加东西”的入口。少了它们，这台机器会慢慢漂移成一个和标准服务器不一样的东西，而且还不会有任何报错。  
2. 七十多个 `rc` 状态的残留包。`dpkg -l | awk '$1=="rc"'` 一拉一大片，从 `6.8.0-56` 到 `6.8.0-137` 的历代内核、`linux-modules-*`、`jellyfin-ffmpeg7`、`cloud-init` 全在里面，都是“文件删了、配置留着”。  
3. `slirp4netns` 和 `libslirp0` 也被 autoremove 带走了。这俩是 rootless 容器联网要用的，而我装了 `docker-ce-rootless-extras`。目前跑的是 rootful，没影响，但哪天想用 rootless 就会发现莫名其妙不通。  
4. 根分区 82%。56G 用了 44G，其中 `/srv/media` 一个目录就占了 25G。日常没什么影响，但想升级到 26.04 就偏紧了(`do-release-upgrade` 一般建议留 15G 以上)，顺便把 200M 的 journal 清了一下。  
5. `/etc` 里的升级残渣。`/etc/default/grub.ucf-dist` 和 `/etc/ca-certificates.conf.dpkg-old`。前者我 diff 过，跟当前的 `/etc/default/grub` 一字不差，纯垃圾。  
6. Docker 和 Jellyfin 的大版本跳跃反而是虚惊一场。`docker-ce 28.1.1 → 29.8.1`、`containerd.io 1.7.27 → 2.3.5`、`docker-compose-plugin 2.35.1 → 5.5.1`(这个跨度有点吓人)。启动日志里有一串 `Deleting nftables IPv4 rules ... table ip docker-bridges`，看着挺唬人，其实是 INFO 级别的清理动作，无害。`jellyfin` 从 `12.0-rc6` 直接升到了正式的 `12.1`，涉及数据库迁移，不过服务是 active，错误日志也是空的。唯一要留意的就是 compose 从 2.x 跳到了 5.x，以后跑 compose 文件时得验一下。  

> 另外还有个我自己都觉得有趣的发现：这台机器的 DNS 是被网关改写过的。`archive.ubuntu.com` 会被解析成 `28.0.2.10` 和 `fc00::8d` 这种明显不对的地址(前者是美国的军用网段，后者是 ULA)，但 HTTPS 请求依然能正常返回 `Apache/2.4.58 (Ubuntu)`。也就是说我的网关一直在做 DNS 改写加透明镜像。apt 能用全靠它，但如果哪天要升级 26.04，就得先确认这个网关有没有同步 `resolute` 的包，否则升级会卡在半路。  

# 小结
这次事故里我没犯什么高深的错误，全是“知道但没当回事”的常识：  

1. `apt remove` 会级联删除反向依赖。删任何东西之前，先 `apt remove -s <包>` 干跑一遍，看它到底要动哪些包。这条命令我以前一直懒得敲，现在觉得它是最划算的一秒钟。  
2. 不要删 ubuntu 元包。它们不占地方，但代表了“系统默认应该有什么”。  
3. `apt autoremove` 只是执行者，不是元凶。它删的每一个包，都是在更早的操作里就已经失去主人的。这次真正该死的是 8 月 15 号那条 remove。  
4. 同一时刻只保留一套网络配置。netplan 和 systemd-networkd 原生配置混用不会报错，只会静默失效，比直接报错难查得多。判断方法也很简单：`netplan status` 看接口是不是 `unmanaged`，`networkctl status <网卡>` 看 `Network File` 指向哪个文件。  
5. 升级之后花一分钟体检。`systemctl --failed`、`dpkg -C`、`dpkg -l | awk '$1=="rc"'`，再加上 `/etc` 下的 `*.dpkg-old` 和 `*.ucf-dist`，这几个命令基本能捞出大部分问题。  
6. 动手改网络之前，先想好怎么进去。对一台只有网线、没有带外管理的虚拟机来说，Proxmox 的控制台就是最后一根救命稻草，别只留一条 SSH。  

最后说一点感受：这台机器上真正被“升级”破坏的东西，其实一件都没有。升级只是把一个月前那个决定的时间等到了而已。这大概也是为什么我更喜欢把这类事情在日志里复盘一遍，不然下次遇到类似的现象，我大概还是会得出“升级把配置弄丢了”这种听起来很合理、但完全错误的结论。  

**后续如果还有其他的变动依然会记录在这篇文章里。**  
