// docs/.vitepress/config.mjs
export default {
  base: '/prplmesh-docs/',
  
  title: 'prplMesh 技术文库',
  description: 'prplMesh 源码解析、通信架构、Mesh原理与学习指南',
  
  themeConfig: {
    // 顶部导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '核心架构', link: '/architecture' },
      { text: '通信协议', link: '/protocol' },
      { text: '学习计划', link: '/test' }
    ],

    // 左侧侧边栏 (按逻辑分类)
    sidebar: [
      {
        text: '📖 快速入门',
        items: [
          { text: '项目概览与首页', link: '/' },
          { text: '学习计划与思考题', link: '/test' }
        ]
      },
      {
        text: '🏗️ 架构与设计',
        items: [
          { text: '代码框架与核心流程', link: '/code' },
          { text: '架构哲学与商业落地', link: '/architecture' },
          { text: '商用适配与 pWHM 指南', link: '/guide' }
        ]
      },
      {
        text: '📡 协议与底层',
        items: [
          { text: '通信机制完整解析 (UDS/LocalBus)', link: '/protocol' },
          { text: 'WiFi Mesh 帧结构与流程', link: '/wifi-frame' }
        ]
      }
    ],

    // 社交链接 (可选)
    socialLinks: [
      { icon: 'github', link: 'https://github.com/prplfoundation/prplMesh' }
    ],

    // 页脚文字 (可选)
    footer: {
      message: '基于 prplMesh 源码深度解析',
      copyright: '个人学习笔记分享'
    },

    // 搜索功能 (默认开启，本地搜索)
    search: {
      provider: 'local'
    },

    // 文档编辑链接 (可选，如果你把文档传到了 GitHub)
    editLink: {
      pattern: 'https://github.com/qitingx/prplmesh-docs/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页'
    }
  }
}
