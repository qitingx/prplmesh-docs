# 常见问题 (FAQ)

## 关于 prplMesh

### Q1: prplMesh 是什么？

prplMesh 是一个开源的 Wi-Fi EasyMesh 实现，符合 Wi-Fi Alliance 的 EasyMesh 标准。它提供了完整的 Multi-AP 架构实现，包括 Controller 和 Agent 组件。

### Q2: prplMesh 的主要功能有哪些？

- **拓扑管理**：自动发现和管理网络拓扑
- **频段引导**：智能引导设备连接到最佳频段
- **漫游优化**：支持 802.11k/v/r 漫游协议
- **负载均衡**：动态分配客户端到不同的 AP
- **统一配置**：通过 Controller 统一管理所有 Agent

---

## 安装与配置

### Q3: 如何编译 prplMesh？

```bash
# 克隆仓库
git clone https://github.com/prplfoundation/prplMesh.git
cd prplMesh

# 编译
mkdir build && cd build
cmake ..
make -j$(nproc)
```

### Q4: 如何启动 Controller 和 Agent？

**启动 Controller：**
```bash
./bin/controller -c /path/to/controller_config.ini
```

**启动 Agent：**
```bash
./bin/agent -c /path/to/agent_config.ini
```

### Q5: 配置文件在哪里？

配置文件通常位于：
- Controller: `/etc/prplmesh/controller_config.ini`
- Agent: `/etc/prplmesh/agent_config.ini`

---

## 技术细节

### Q6: Controller 和 Agent 如何通信？

Controller 和 Agent 通过 IEEE 1905.1 协议通信，使用 EtherType `0x893a`。通信方式包括：

- **外部通信**：通过以太网帧（L2）与其他设备通信
- **内部通信**：通过 Unix Domain Socket (UDS) 在本地进程间通信

详细内容请参考 [通信机制完整解析](/protocol)。

### Q7: 什么是 UDS 和 Local Bus？

- **UDS (Unix Domain Socket)**：用于同一主机上进程间通信的套接字
- **Local Bus**：prplOS 提供的系统级 IPC 机制，基于 Ambiorix Bus

在 prplMesh 中：
- Controller/Agent 与 Transport 进程通过 UDS 通信
- Transport 进程负责 1905 报文的收发和转发

### Q8: 如何查看日志？

```bash
# 查看 Controller 日志
journalctl -u prplmesh-controller -f

# 查看 Agent 日志
journalctl -u prplmesh-agent -f

# 查看 Transport 日志
journalctl -u prplmesh-transport -f
```

---

## 故障排查

### Q9: Agent 无法连接到 Controller 怎么办？

**检查步骤：**

1. 确认网络连通性：
```bash
ping <controller-ip>
```

2. 检查 1905 报文是否正常：
```bash
tcpdump -i eth0 ether proto 0x893a
```

3. 查看日志错误信息：
```bash
journalctl -u prplmesh-agent | grep -i error
```

### Q10: 如何调试 1905 报文？

使用 Wireshark 抓包：
```bash
# 抓取 1905 报文
tcpdump -i eth0 -w 1905.pcap ether proto 0x893a

# 使用 Wireshark 打开
wireshark 1905.pcap
```

---

## 更多资源

- [项目概览与首页](/)
- [代码框架与核心流程](/code)
- [通信机制完整解析](/protocol)
- [架构哲学与商业落地](/architecture)
