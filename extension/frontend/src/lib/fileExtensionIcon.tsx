import React from 'react'
import { Braces, File, FileCode, FileImage, FileJson, FileText, type LucideIcon } from 'lucide-react'

type ExtensionStyle = {
  icon: LucideIcon
  color: string
}

const EXTENSION_STYLES: Record<string, ExtensionStyle> = {
  ts: { icon: FileCode, color: '#60a5fa' },
  tsx: { icon: FileCode, color: '#38bdf8' },
  js: { icon: FileCode, color: '#facc15' },
  jsx: { icon: FileCode, color: '#fbbf24' },
  py: { icon: FileCode, color: '#fbbf24' },
  json: { icon: FileJson, color: '#fb923c' },
  md: { icon: FileText, color: '#94a3b8' },
  css: { icon: Braces, color: '#a78bfa' },
  scss: { icon: Braces, color: '#c084fc' },
  html: { icon: FileCode, color: '#f87171' },
  png: { icon: FileImage, color: '#4ade80' },
  jpg: { icon: FileImage, color: '#4ade80' },
  jpeg: { icon: FileImage, color: '#4ade80' },
  svg: { icon: FileImage, color: '#2dd4bf' },
  gif: { icon: FileImage, color: '#4ade80' },
  webp: { icon: FileImage, color: '#4ade80' },
}

const getExtension = (path: string): string => {
  const name = path.split(/[/\\]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const FileExtensionIcon: React.FC<{ path: string; className?: string }> = ({
  path,
  className = 'h-3.5 w-3.5 shrink-0',
}) => {
  const ext = getExtension(path)
  const style = EXTENSION_STYLES[ext] ?? { icon: File, color: '#7f91b4' }
  const Icon = style.icon

  return <Icon className={className} style={{ color: style.color }} aria-hidden />
}
