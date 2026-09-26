// 缩放压缩，控制传输体积（1568px 为 OpenAI 多模态建议尺寸）
export function fileToDataURL(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    const maxDim = 1568
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    resolve(canvas.toDataURL('image/webp', 1))
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    reject(new Error('图片加载失败'))
  }
  img.src = url
  return promise
}