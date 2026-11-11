/**
 * 前端应用主入口文件 (Main Entry Point)
 * 
 * 职责：
 * 1. 初始化 React 根渲染节点 (createRoot)。
 * 2. 引入全局重置样式与基础布局样式 (index.css)。
 * 3. 在 React 严格模式 (StrictMode) 下挂载核心组件 <App />。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 获取 DOM 挂载容器并初始化 React 18+ 的根渲染器
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 渲染主应用组件，提供双栏 PDF 交叉探测/对比界面 */}
    <App />
  </StrictMode>,
)
