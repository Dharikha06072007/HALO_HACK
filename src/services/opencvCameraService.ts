export type CameraQuality = { brightness: 'DARK' | 'GOOD' | 'BRIGHT'; sharpness: 'CLEAR' | 'POSSIBLY_BLURRY'; frozen: boolean; message: string }

type OpenCv = { Mat: new () => any; cvtColor: (source: any, target: any, code: number) => void; mean: (mat: any) => { 0: number }; Laplacian: (source: any, target: any, depth: number) => void; meanStdDev: (source: any, mean: any, std: any) => void; COLOR_RGBA2GRAY: number; CV_64F: number; imread: (element: HTMLVideoElement) => any }
let cv: OpenCv | null = null
let previousSignature = ''
let unchangedFrames = 0

export async function initializeOpenCV(): Promise<boolean> {
  const existing = (window as Window & { cv?: OpenCv }).cv
  if (existing) { cv = existing; return true }
  if (document.querySelector('script[data-skillsync-opencv]')) return false
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://docs.opencv.org/4.x/opencv.js'
    script.async = true
    script.dataset.skillsyncOpencv = 'true'
    script.onload = () => { cv = (window as Window & { cv?: OpenCv }).cv ?? null; resolve(Boolean(cv)) }
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
}

export function analyzeFrame(video: HTMLVideoElement): CameraQuality {
  if (!cv || video.readyState < 2 || video.videoWidth === 0) return { brightness: 'GOOD', sharpness: 'CLEAR', frozen: false, message: 'Camera frame unavailable.' }
  let source: any
  let gray: any
  let laplacian: any
  try {
    source = cv.imread(video)
    gray = new cv.Mat()
    laplacian = new cv.Mat()
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    const intensity = cv.mean(gray)[0]
    cv.Laplacian(gray, laplacian, cv.CV_64F)
    const mean = new cv.Mat()
    const std = new cv.Mat()
    cv.meanStdDev(laplacian, mean, std)
    const variance = std.data64F?.[0] ? std.data64F[0] ** 2 : 100
    const signature = `${Math.round(intensity)}-${Math.round(variance)}`
    unchangedFrames = signature === previousSignature ? unchangedFrames + 1 : 0
    previousSignature = signature
    const brightness = intensity < 55 ? 'DARK' : intensity > 205 ? 'BRIGHT' : 'GOOD'
    const sharpness = variance < 35 ? 'POSSIBLY_BLURRY' : 'CLEAR'
    const frozen = unchangedFrames >= 8
    return { brightness, sharpness, frozen, message: frozen ? 'Camera may be frozen.' : brightness === 'DARK' ? 'Lighting is low.' : sharpness === 'POSSIBLY_BLURRY' ? 'Camera may be blurry.' : 'Camera quality looks good.' }
  } finally {
    source?.delete(); gray?.delete(); laplacian?.delete()
  }
}

export function cleanupOpenCV(): void { cv = null; previousSignature = ''; unchangedFrames = 0 }
