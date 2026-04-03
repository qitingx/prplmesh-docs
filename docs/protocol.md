# 			prplMesh 通信机制完整解析



## 一、外部通信：与其他厂家 EasyMesh CPE

### 1. 物理层传输方式

- **协议**：IEEE 1905.1，EtherType = `0x893a`（ETH_P_1905*1）*

- **Socket 类型**：`AF_PACKET + SOCK_RAW`（二层原始套接字）

- **接收过滤**：BPF 内核过滤器，只接收 1905.1 和 LLDP 报文

- **UCC 认证端口**：**TCP 8002**（`UCC_LISTENER_PORT`），用于 Wi-Fi Alliance 认证工具连接

- | 来源                                 | 端口     | 说明                                                         |
  | :----------------------------------- | :------- | :----------------------------------------------------------- |
  | **Wi-Fi Alliance EasyMesh 认证规范** | **5000** | WFA 官方 UCC (Unified Configuration and Control) 接口标准端口 |
  | **prplMesh 实际实现**                | **8002** | Intel/prplMesh 团队选择的自定义端口                          |
  | **RDK-B 等其他实现**                 | **7170** | 某些厂商使用 UDP 7170（可能是其他协议或历史遗留）            |

### 2. 数据流向

```
其他厂家 CPE ──二层以太网──► prplMesh 网卡 (ethX)
                  │
                  ▼
          Transport 进程 (raw socket recvfrom)
                  │
                  ▼
          BrokerServer (UDS: /tmp/uds_broker)
                  │
                  ▼
          Controller/Agent (BrokerClient)
```

------

## 二、内部通信：Controller ↔ Agent

### 1. 架构设计

plaintext

```
┌──────────────┐     UDS      ┌──────────────┐     UDS      ┌──────────────┐
│  Controller  │ ◄──────────► │   Transport  │ ◄──────────► │    Agent     │
│ broker_client │  uds_broker  │ BrokerServer │  uds_broker  │ broker_client │
└──────────────┘              └──────────────┘              └──────────────┘
```

- **Controller 和 Agent**：都是 `broker_client`，连接到 `/tmp/uds_broker`
- **Transport 进程**：唯一的 `broker_server`，监听 UDS socket
- **消息格式**：必须是 1905 CMDU 格式（包括 `VENDOR_SPECIFIC_MESSAGE` 封装私有扩展）
- **本质**：**两层 UDS 串联**的变相通信

### 2. Local Bus 的真实含义

> **Local Bus = UDS/BrokerServer 通道**在 Transport 内部的抽象别名，**不是 ZeroMQ，也不是 D-Bus**。

而prplmesh真正的local bus是指：

```
enum InterfaceType {    IF_TYPE_NET,        // 来自/去往 物理网卡（raw socket）   
                        IF_TYPE_LOCAL_BUS,  // 来自/去往 本地进程（UDS/Broker） };
```

------

## 三、Transport 双通道架构

### 1. 两个独立的 IO 来源

| 特性            | 网卡侧（IF_TYPE_NET）            | 本地总线侧（IF_TYPE_LOCAL_BUS）                         |
| :-------------- | :------------------------------- | :------------------------------------------------------ |
| **实现文件**    | `ieee1905_transport_network.cpp` | `ieee1905_transport_local_bus.cpp`                      |
| **Socket 类型** | `AF_PACKET` raw socket           | Unix Domain Socket (UDS)                                |
| **数量**        | 每个网络接口一个 fd              | 一个 server fd + N 个 client 连接                       |
| **收发函数**    | `recvfrom()` / `writev()`        | `read_transport_message()` / `send_transport_message()` |
| **注册到**      | EventLoop (epoll)                | EventLoop (epoll)                                       |

### 2. 统一处理流程

plaintext

```
收包路径1（网卡 → Broker）：
  物理网卡 ──raw socket──► handle_interface_pollin_event()
                              │
                              ▼
                          handle_packet() ──forward_packet()──► send_packet_to_broker()
收包路径2（Broker → 网卡）：
  BrokerServer ──handle_broker_cmdu_tx_message()──► handle_packet()
                                                      │
                                                      ▼
                                              forward_packet() ──► send_packet_to_network_interface()
```

------

## 四、转发规则详解

### 1. 转发决策表（简化版）

| 来源                       | 报文类型       | 转发到 Broker(UDS) | 转发到网桥 | 直接发网卡       |
| :------------------------- | :------------- | :----------------- | :--------- | :--------------- |
| **LOCAL_BUS** (本设备发出) | 多播           | ✅                  | ❌          | ✅ (所有物理口)   |
| **NET** (网卡收到)         | 多播 + relay=1 | ✅                  | ❌          | ✅ (除来源口)     |
| **NET** (网卡收到)         | 多播 + relay=0 | ✅                  | ❌          | ❌                |
| **NET** (网卡收到)         | 单播不是本设备 | ❌                  | ❌          | ❌ (Linux 网桥转) |
| **LOCAL_BUS** (本设备发出) | 单播不是本设备 | ❌                  | ✅          | ❌                |
| **任意**                   | 单播是本设备   | ✅                  | ❌          | ❌                |

### 2. "转发到网桥" vs "直接发网卡"

#### 转发到网桥（`forward_to_bridge = true`）

- **适用场景**：LOCAL_BUS 发出的**单播**报文，目标不是本设备
- **做法**：写入 `br-lan` 网桥设备的 raw socket
- **谁决定出口**：Linux 内核查 FDB 表自动选择从 eth0 还是 eth1 出去
- **优点**：利用内核学习算法，无需 Transport 知道目标 MAC 位置

#### 直接发网卡（`forward_to_network_interfaces = true`）

- **适用场景**：**多播**报文（需要泛洪）

- **做法**：遍历所有物理接口（eth0, eth1, wlan0...）逐一发送

- **为什么不走网桥**：ebtables 规则禁止网桥转发 1905 多播报文，避免重复  

  在 Linux 平台上，需要通过 `ebtables -A FORWARD -d 01:80:c2:00:00:13 -j DROP` 命令阻止内核自动转发这些组播报文，让 ieee1905_transport 组件来控制转发逻辑

  
  
  ![image-20260401213406427](/images/protocol/protocol_md_1.png)
  
  

### 3. 关键代码逻辑（第648-653行）

cpp   ieee1905_transport_packet_processing.cpp

```c++
if (((forward_to_bridge && network_interface.is_bridge) ||
     (forward_to_network_interfaces && !network_interface.is_bridge)) &&
    (network_interface.fd) &&
    !(packet.src_if_type == IF_TYPE_NET && packet.src_if_index == if_index)) {
    fragment_and_send_packet_to_network_interface(if_index, packet);
}
```

------

## 五、核心文件职责一览

| 文件                                       | 职责                                                      |
| :----------------------------------------- | :-------------------------------------------------------- |
| `main.cpp`                                 | 进程入口，创建 EventLoop、BrokerServer、Ieee1905Transport |
| `ieee1905_transport.h/.cpp`                | 类定义与初始化，注册消息回调                              |
| `ieee1905_transport_broker.h/.cpp`         | BrokerServer 实现，订阅/分发管理                          |
| `ieee1905_transport_local_bus.cpp`         | 处理 UDS/Broker 侧消息                                    |
| `ieee1905_transport_network.cpp`           | 管理 raw socket，收发网卡报文                             |
| `ieee1905_transport_packet_processing.cpp` | 转发决策引擎（handle_packet + forward_packet）            |
| `ieee1905_transport_messages.h/.cpp`       | 内部消息格式定义与序列化                                  |

------

### 一句话总结

> **prplMesh Transport 是一个 epoll 驱动的双向代理**：向外侧通过 `AF_PACKET` raw socket 直接与外部设备交换二层 1905 帧；向内侧通过 UDS/BrokerServer 与 Controller/Agent 通信。两侧消息在 `handle_packet()` 中统一决策，根据报文类型（单播/多播）和目标地址，智能选择"走网桥让内核查表"或"手动逐口泛洪"。**Local Bus 只是 UDS 通道的内部别名，不是独立传输机制。**



## 六、Local BUS vs UDS：

#### 1. **Local Bus（本地总线）**

Local Bus 是prplOS/prplMesh中用于**同一设备内部进程间通信(IPC)** 的主要方式com/prplfoundation/prplMesh-controller/blob/master/README.md。它通常指的是 **Ambiorix Bus**，这是prplOS自有的总线系统。

- **定义**：Ambiorix Bus 是prplOS架构的核心组件，它适配了不同操作系统中的各种总线架构（如RDK-B的R-Bus、Linux桌面环境的D-Bus、OpenWrt的U-Bus等），提供统一的IPC机制。
- **在prplMesh中的应用**：当Controller和Agent运行在同一台物理设备上时，它们之间的通信（如配置同步、状态查询）可以通过Local Bus进行。这是**最标准、最推荐的同机通信方式**。
- **关系**：可以认为Local Bus是D-Bus思想在prplOS生态中的具体实现，但它们不是同一个东西。prplOS选择自建Ambiorix Bus以解决跨平台兼容性问题。

#### 2. **UDS (Unix Domain Socket)**

UDS 是一种传统的、底层的进程间通信机制，允许同一台机器上的进程通过文件系统路径进行通信。

- 在prplMesh中的应用

  ：UDS在prplMesh中主要有两个用途：

- **局限性**：UDS仅限于**同一主机**内的进程通信，无法用于网络中不同设备间的通信。



#### 1. 业务控制面：1905 报文及其 Transport 进程（走 UDS）

Controller 和 Agent 要交换拓扑发现、配置等 **Multi-AP 业务逻辑**，这些信息按照 **IEEE 1905.1 标准** 封装成 CMDU 报文。

- **问题**：1905 标准定义的是**网络层协议**，报文最终需要通过L2网络（以太网帧）发送。但 Controller 和 Agent 是**同一主机上的两个用户态进程**，它们不能直接“发网络包”。
- **解决方案**：这就是 **Transport 进程** 存在的意义。它是一个独立的核心守护进程，扮演“协议转换与分发中心”的角色。
- **内部实现**：Controller 和 Agent 将构造好的 1905 CMDU 报文，通过**本地的 UDS 套接字**发送给 Transport 进程。Transport 进程负责将这些报文**注入到网络协议栈**，发往外部；同时，它也会接收外部发来的 1905 报文，再通过 UDS **分发给本机的 Controller 或 Agent**。
- **证据**：prplMesh 的核心组件 README 中明确提到，Agent 和 Controller 需要在同一主机上或具有 L2 连接，并且 **“provided the BTL is using the local bus and not UDS mode”**。这里的 **“BTL”很可能就是指 Bridge/Transport Layer**。这证明在 UDS 模式下，Controller/Agent 是通过 UDS 与 Transport 进程通信，而 Transport 进程才真正连接到“local bus”或网络。

#### 2. 系统管理面：Ambiorix Local Bus（不走 1905 报文）

Local Bus 是 prplOS 提供的**系统级进程通信基础设施**，与 1905 协议是两套独立的系统。

- **用途**：它用于 prplMesh 与操作系统其他组件（如数据模型、配置存储、硬件抽象层 pWHM）的集成。例如，通过 **NBAPI** (Northbound API) 暴露网络信息gitlab.com，或接收来自 USP Agent 的管理请求。

- **内容**：传递的是 **TR-181 数据模型** 的操作（如 `Get`、`Set` 请求）、配置变更、系统事件等**管理信息**，而不是 1905 业务报文。

- **关系**：可以认为 Local Bus 是 prplOS 的“管理总线”，而 1905 Transport 是 prplMesh 的“业务总线”。两者在 prplMesh 架构中协同工作，但职责清晰分离


| 特性                   | **Local Bus (Ambiorix)**                    | **UDS (Unix Domain Socket)**           |
| :--------------------- | :------------------------------------------ | :------------------------------------- |
| **通信范围**           | **同一设备内**（prplmesh--pwhm）            | **同一设备内**（broker client/server） |
| **通信对象**           | prplMesh与其他系统组件                      | 进程或模块之间，Agent与Controller      |
| **技术本质**           | 高层IPC总线系统，适配多种底层实现           | 底层套接字API，基于文件系统路径        |
| **在prplMesh中的角色** | **主流、推荐的同机通信方式**                | prplmesh 进程间                        |
| **是否等同于D-Bus**    | **否**。是prplOS自有的、类似D-Bus的总线系统 | **否**。是更底层的系统调用             |
| **跨设备能力**         | **无**                                      | **无**                                 |



## 七、BML（Controller） 和Transport进程的关系：

- BML 是一个 **C 语言库** (`libbml.so`)

- 被 **外部 USP/TR-181 Server 进程**链接使用

- 外部进程调用 `bml_connect()` → **该进程**创建 UDS socket 连接 Controllers

- **Controller 内部的 `bml_task` 只负责事件分发，不直接处理 UDS 通信。**

- BML 监听器会收到 DB 变化的**事件通知**，但那是给外部 USP/TR-181 Server 用的，不是用来触发 1905 报文发送的。

  

| 特性                             | Push/Pull?    | 说明                                        |
| :------------------------------- | :------------ | :------------------------------------------ |
| **Transport → Controller/Agent** | **Pure PUSH** | BrokerServer 主动 publish，无需客户端请求   |
| **Controller 处理报文**          | **Immediate** | 收到后立即调用 handle_cmdu**，同步执行 \|** |

| **DB 更新**          | **Synchronous**       | 直接在处理函数中修改内存对象                   |
| :------------------- | :-------------------- | :--------------------------------------------- |
| **BML 事件通知**     | **Event-driven PUSH** | Task 触发事件 → bml_task 遍历监听器 → 主动推送 |
| **BML 查询网络拓扑** | **PULL（仅此一例）**  | `bml_nw_map_query()` 主动请求全量拓扑          |

> **结论**：prplMesh 的内部消息传递机制是**以 PUSH 为主，PULL 为辅**。1905 报文处理、DB 更新、BML 事件通知全部采用**事件驱动的主动推送模式**，只有 BML 查询全量拓扑时使用了一次性 PULL（`bml_nw_map_query()`）
>
> 

```
┌─────────────────────────────────────────────────────────────┐
│                    Controller 进程                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  main()                                                 │ │
│  │    ├─► 创建 EventLoop                                   │ │
│  │    ├─► 创建 db 对象                                      │ │
│  │    ├─► 创建 task_pool                                   │ │
│  │    └─► 创建各个 Task（包括 bml_task）                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  bml_task (内部 Task 之一)                               │ │
│  │    - 不负责与 BML Library 通信                          │ │
│  │    - 只负责事件分发                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  network_map::send_bml_event_to_listeners()             │ │
│  │    └─► for (int fd : bml_listeners)                     │ │
│  │          controller_ctx->send_cmdu(fd, cmdu_tx)         │ │
│  │               ▲                                         │ │
│  │               │ 这些 fd 是外部 BML Library 连接的 UDS socket │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                     │
                     │ UDS (独立连接)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              外部进程：USP / TR-181 Server                    │
│                  (或测试工具、CLI 等)                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  BML Library (bml_internal.cpp)                         │ │
│  │    connect_to_master()                                  │ │
│  │      └─► socket(AF_UNIX, SOCK_STREAM)                   │ │
│  │      └─► connect("/tmp/uds_controller")                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```


外部Agent向本机Controller发送`Topology Discovery`报文：

![image-20260401214931845](/images/protocol/protocol_md_2.png)

完整的流程：

```
┌──────────────────────────────────────────────────────────────────────┐
│                        外部 EasyMesh CPE                              │
│                         (其他厂家设备)                                │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ 1905 报文 (ETH_P_1905_1)
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    prplMesh Transport 进程                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ieee1905_transport_network.cpp                                │ │
│  │  handle_interface_pollin_event()                               │ │
│  │    └─► recvfrom(raw_socket)  ◄────── AF_PACKET socket          │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ieee1905_transport_packet_processing.cpp                      │ │
│  │  handle_packet() + forward_packet()                            │ │
│  │    └─► if (目标是本设备) forward_to_broker = true              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ieee1905_transport_local_bus.cpp                              │ │
│  │  send_packet_to_broker()                                       │ │
│  │    └─► m_broker->publish(CmduRxMessage)                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ieee1905_transport_broker.cpp                                 │ │
│  │  BrokerServer::publish()                                       │ │
│  │    └─► for (auto soc : m_type_to_soc[type])                   │ │
│  │          send_transport_message(*soc, msg)  ◄── UDS socket     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
                     │
                     │ UDS (/tmp/uds_broker)
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Controller / Agent                                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  broker_client_impl.cpp                                        │ │
│  │  BrokerClientImpl::handle_read()                               │ │
│  │    └─► receive(UDS) → parse → notify_cmdu_received()           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  controller.cpp                                                │ │
│  │  handle_cmdu_from_broker()                                     │ │
│  │    └─► handle_cmdu_1905_*_message()                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  db.cpp                                                        │ │
│  │  update_agent_radio() / set_station_state() 等                 │ │
│  │    └─► 直接修改内存中的 Agent/Station 对象                      │ │
│  │    └─► dm_update_radio_params() 同步更新 Data Model             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  tasks/topology_task.cpp                                       │ │
│  │  触发 BML 事件                                                   │ │
│  │    └─► tasks.push_event(bml_task_id, TOPOLOGY_RESPONSE_UPDATE) │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  tasks/bml_task.cpp                                            │ │
│  │  handle_event()                                                │ │
│  │    └─► 遍历 m_bml_sockets 列表                                  │ │
│  │    └─► send_bml_event_to_listeners(...)                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  network_map.cpp                                               │ │
│  │  send_bml_event_to_listeners()                                 │ │
│  │    └─► controller_ctx->send_cmdu(fd, cmdu_tx)                  │ │
│  │         ◄────── 直接写入 BML 的 UDS socket (非 Broker)            │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
                     │
                     │ UDS (独立连接)
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         BML Library                                   │
│                   (USP/TR-181 Server 调用层)                          │
│                                                                      │
│  bml_internal.cpp::event_loop()                                      │
│    └─► 监听 Controller 发来的事件通知                                 │
│    └─► 解析 BML_EVENT 结构体                                         │
│    └─► 调用注册的回调函数 (BML_EVENT_CB)                              │
└──────────────────────────────────────────────────────────────────────┘
                     │
                     │ C API 返回
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    USP / TR-181 Server                                │
│                     (ACS 远程管理协议)                                 │
└──────────────────────────────────────────────────────────────────────┘
```

