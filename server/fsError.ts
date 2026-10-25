// 把 fs / spawn 的底层错误翻译成可直接给模型看的错误；未知错误保留原始 message。
// 目标路径由调用方给出（显示相对路径或绝对路径都行）。
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function fsErrorText(err: unknown, target: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  switch (code) {
    case 'ENOENT':
      return `路径不存在: ${target}`
    case 'EACCES':
    case 'EPERM':
      return `没有权限访问: ${target}`
    case 'EISDIR':
      return `目标是目录，不是文件: ${target}`
    case 'ENOTDIR':
      return `路径中有一段不是目录: ${target}`
    case 'EEXIST':
      return `目标已存在且不是目录: ${target}`
    case 'ENOSPC':
      return `磁盘空间不足: ${target}`
    case 'ENAMETOOLONG':
      return `路径过长: ${target}`
    case 'EBUSY':
      return `文件被占用: ${target}`
    case 'EROFS':
      return `只读文件系统，无法写入: ${target}`
    case 'EMFILE':
    case 'ENFILE':
      return `打开的文件过多: ${target}`
    case 'ELOOP':
      return `符号链接层级过深: ${target}`
    case 'EIO':
      return `磁盘 I/O 错误: ${target}`
    default:
      return errText(err)
  }
}
