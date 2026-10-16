---
layout: home

hero:
  name: StoreWeave
  text: 架構、決策與開發文件
  tagline: 模組化單體的設計說明、ADR，以及模組、Extension 與部署的開發指南
  actions:
    - theme: brand
      text: 架構總覽
      link: /architecture
    - theme: alt
      text: 決策紀錄（ADR）
      link: /adr/README

features:
  - title: 架構總覽
    details: 模組邊界、Command／Query／Event 流向與目錄結構。
    link: /architecture
  - title: 決策紀錄
    details: 每一項架構決策的背景、取捨與狀態。
    link: /adr/README
  - title: 模組開發
    details: 從建立套件到站點組裝，新增一個模組的完整步驟。
    link: /module-development
  - title: Extension 開發
    details: 串接外部服務、資料由對方保管的需求。
    link: /extension-development
  - title: Docker 部署
    details: 以 Docker 部署 StoreWeave。
    link: /deployment-docker
  - title: 原生部署
    details: 以 tarball 在主機上直接安裝與執行。
    link: /deployment-native
---
