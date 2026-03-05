import axios from 'axios'
import FormData from 'form-data'
import sharp from 'sharp'
import {
  BaseImageGenerator,
  BaseVideoGenerator,
  type GenerateResult,
  type ImageGenerateParams,
  type VideoGenerateParams,
} from './base'
import { getProviderConfig } from '@/lib/api-config'
import { createScopedLogger } from '@/lib/logging/core'
import { imageUrlToBase64 } from '@/lib/cos'

interface RunningHubUploadData {
  download_url?: string
}

interface RunningHubUploadResponse {
  code: number
  data?: RunningHubUploadData
}

interface RunningHubTaskFailedReason {
  exception_message?: string
}

interface RunningHubTaskItem {
  fileUrl?: string
  failedReason?: RunningHubTaskFailedReason
}

interface RunningHubTaskResponse {
  code: number
  msg: string
  data?: RunningHubTaskItem[]
}

interface RunningHubApiErrorPayload {
  taskId?: string
  status?: string
  errorCode?: string
  errorMessage?: string
  [key: string]: unknown
}

function extractRunningHubErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as RunningHubApiErrorPayload & { data?: Array<{ failedReason?: { exception_message?: string }; errorMessage?: string }>; msg?: string }
  const msg = typeof obj.errorMessage === 'string' ? obj.errorMessage.trim() : null
  if (msg) return msg
  const reason = obj.failedReason as { exception_message?: string } | undefined
  const ex = typeof reason?.exception_message === 'string' ? reason.exception_message.trim() : null
  if (ex) return ex
  const first = Array.isArray(obj.data) ? obj.data[0] : null
  if (first) {
    const firstMsg = typeof first.errorMessage === 'string' ? first.errorMessage.trim() : null
    if (firstMsg) return firstMsg
    const firstEx = typeof first.failedReason?.exception_message === 'string' ? first.failedReason.exception_message.trim() : null
    if (firstEx) return firstEx
  }
  const topMsg = typeof obj.msg === 'string' ? obj.msg.trim() : null
  if (topMsg && topMsg !== 'success') return topMsg
  return null
}

const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn'

/** modelId → 接口路径（无前导 /openapi/v2/） */
const RUNNINGHUB_MODEL_PATH_MAP: Record<string, string> = {
  'rhart-image-n-g31-flash': 'rhart-image-n-g31-flash',
  'rhart-image-n-g31-flash-official': 'rhart-image-n-g31-flash-official',
  'rhart-image-n-g31-flash-image-to-image': 'rhart-image-n-g31-flash',
  'rhart-image-n-g31-flash-official-image-to-image': 'rhart-image-n-g31-flash-official',
  'rhart-image-n-pro': 'rhart-image-n-pro',
  'rhart-image-n-pro-image-to-image': 'rhart-image-n-pro',
}

/** 图生图使用 /edit 接口的 modelId（非 /image-to-image） */
const RUNNINGHUB_IMAGE_EDIT_PATH_MAP: Record<string, string> = {
  'rhart-image-n-pro-image-to-image': 'rhart-image-n-pro/edit',
}

/** 全能图片PRO 系列：aspectRatio 必填，允许值 */
const RHART_IMAGE_N_PRO_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '16:9', '9:16', '21:9'])

function normalizeAspectRatioForPro(raw?: string): string {
  const s = (raw || '').trim()
  if (RHART_IMAGE_N_PRO_ASPECT_RATIOS.has(s)) return s
  return '3:2'
}

function getRunningHubModelPath(modelId?: string): string {
  const id = (modelId || '').trim()
  return RUNNINGHUB_MODEL_PATH_MAP[id] || 'rhart-image-n-g31-flash'
}

function getRunningHubImageEndpoint(modelId: string | undefined, hasReferenceImages: boolean): string {
  const id = (modelId || '').trim()
  if (hasReferenceImages && RUNNINGHUB_IMAGE_EDIT_PATH_MAP[id]) {
    return RUNNINGHUB_IMAGE_EDIT_PATH_MAP[id]
  }
  const modelPath = getRunningHubModelPath(modelId)
  return hasReferenceImages ? `${modelPath}/image-to-image` : `${modelPath}/text-to-image`
}

function normalizeResolution(raw?: string): string {
  const value = (raw || '').trim().toLowerCase()
  if (value === '1k' || value === '2k' || value === '4k') return value
  if (value === '0.5k') return '1k'
  return '1k'
}

async function uploadBase64ToRunninghub(
  base64Image: string,
  apiKey: string,
  options?: { maxSizeMB?: number },
): Promise<string> {
  const cleanedKey = apiKey.replace(/^Bearer\s+/i, '')
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '')
  let buffer = Buffer.from(base64Data, 'base64')

  const maxSizeMB = options?.maxSizeMB ?? 7
  const MAX_SIZE_BYTES = maxSizeMB * 1024 * 1024
  if (buffer.length > MAX_SIZE_BYTES) {
    let quality = 90

    while (buffer.length > MAX_SIZE_BYTES && quality > 10) {
      buffer = await sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer()
      quality -= 10
    }

    if (buffer.length > MAX_SIZE_BYTES) {
      const metadata = await sharp(buffer).metadata()
      const scale = Math.sqrt(MAX_SIZE_BYTES / buffer.length)

      buffer = await sharp(buffer)
        .resize({
          width: Math.floor((metadata.width ?? 1920) * scale),
          height: Math.floor((metadata.height ?? 1080) * scale),
          fit: 'inside',
        })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer()
    }
  }

  const formData = new FormData()
  formData.append('file', buffer, {
    filename: 'image.jpg',
    contentType: 'image/jpeg',
  })

  const uploadRes = await axios.post<RunningHubUploadResponse>(
    'https://www.runninghub.cn/openapi/v2/media/upload/binary',
    formData,
    {
      headers: { Authorization: `Bearer ${cleanedKey}` },
    },
  )

  if (uploadRes.data.code !== 0 || !uploadRes.data.data?.download_url) {
    throw new Error(`RunningHub 图片上传失败: ${JSON.stringify(uploadRes.data)}`)
  }

  return uploadRes.data.data.download_url
}

export class RunningHubImageGenerator extends BaseImageGenerator {
  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params

    const { apiKey } = await getProviderConfig(userId, 'runninghub')
    const cleanedKey = apiKey.replace(/^Bearer\s+/i, '')
    const logger = createScopedLogger({
      module: 'worker.runninghub-image',
      action: 'runninghub_nanobanana_generate',
    })

    const uploadInputs: string[] = []
    for (const ref of referenceImages) {
      if (ref.startsWith('data:')) {
        uploadInputs.push(ref)
      } else {
        const base64 = await imageUrlToBase64(ref)
        uploadInputs.push(base64)
      }
    }

    const imageUrls: string[] = []
    for (const base64 of uploadInputs) {
      const url = await uploadBase64ToRunninghub(base64, cleanedKey)
      imageUrls.push(url)
    }

    const { resolution, aspectRatio, modelId: optionsModelId } = options as {
      resolution?: string
      aspectRatio?: string
      modelId?: string
    }

    const hasReferenceImages = imageUrls.length > 0
    const endpointPath = getRunningHubImageEndpoint(optionsModelId, hasReferenceImages)
    const createTaskUrl = `${RUNNINGHUB_BASE_URL}/openapi/v2/${endpointPath}`
    logger.info({
      message: 'RunningHub nanobanana 请求',
      details: {
        url: createTaskUrl,
        endpoint: endpointPath,
        hasReferenceImages,
        resolution: resolution ?? null,
        aspectRatio: aspectRatio ?? null,
      },
    })

    const body: Record<string, unknown> = {
      prompt,
      resolution: normalizeResolution(resolution),
    }
    const modelId = (optionsModelId || '').trim()
    const isProModel = modelId === 'rhart-image-n-pro' || modelId === 'rhart-image-n-pro-image-to-image'
    if (isProModel) {
      body.aspectRatio = normalizeAspectRatioForPro(aspectRatio)
    } else if (aspectRatio != null && aspectRatio !== '') {
      body.aspectRatio = aspectRatio.trim()
    }
    if (hasReferenceImages) {
      body.imageUrls = imageUrls
    }

    const taskRes = await axios.post<{ taskId?: string }>(createTaskUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanedKey}`,
      },
    })

    const taskId = taskRes.data.taskId
    if (!taskId) {
      const apiMessage = extractRunningHubErrorMessage(taskRes.data)
      const displayMessage = apiMessage ?? `RunningHub 任务创建失败 | url=${createTaskUrl} | modelId=${optionsModelId ?? '(未传)'}`
      throw new Error(displayMessage)
    }

    const pollUrl = `${RUNNINGHUB_BASE_URL}/task/openapi/outputs`
    logger.info({
      message: 'RunningHub 轮询任务结果',
      details: { url: pollUrl, taskId },
    })

    const maxAttempts = 400
    const delayMs = 3000

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: { data: RunningHubTaskResponse }
      try {
        res = await axios.post<RunningHubTaskResponse>(
          pollUrl,
          {
            taskId,
            apiKey: cleanedKey,
          },
        )
      } catch (error: unknown) {
        // RunningHub 轮询偶尔会返回 504/5xx，此时继续等待而不是直接失败
        if (axios.isAxiosError(error)) {
          const status = error.response?.status
          if (status === 504 || status === 502 || status === 503) {
            logger.info({
              message: 'RunningHub 轮询暂时失败，将重试',
              details: { url: pollUrl, taskId, status, attempt },
            })
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                resolve()
              }, delayMs)
            })
            continue
          }
        }
        throw error
      }

      const { code, msg, data } = res.data
      if (code === 0 && msg === 'success') {
        const fileUrl = data?.[0]?.fileUrl
        if (!fileUrl) {
          return {
            success: false,
            error: 'RunningHub 任务成功但未返回 fileUrl',
          }
        }
        return {
          success: true,
          imageUrl: fileUrl,
        }
      }

      if (code === 804 || code === 813) {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve()
          }, delayMs)
        })
        continue
      }

      if (code === 805) {
        const reason = extractRunningHubErrorMessage(res.data) ?? '未知原因'
        throw new Error(`RunningHub 任务失败: ${reason}`)
      }

      throw new Error(`RunningHub 未知状态: code=${code}, msg=${msg}`)
    }

    throw new Error('RunningHub 任务轮询超时')
  }
}

/** modelId → 接口路径（无前导 /openapi/v2/） */
const RUNNINGHUB_VIDEO_ENDPOINT_MAP: Record<string, string> = {
  'rhart-video-s-official-image-to-video-realistic': 'rhart-video-s-official/image-to-video-realistic',
  'rhart-video-s-official-image-to-video': 'rhart-video-s-official/image-to-video',
  'rhart-video-v3.1-fast': 'rhart-video-v3.1-fast/image-to-video',
  'rhart-video-g': 'rhart-video-g/image-to-video',
  'kling-video-o3-pro': 'kling-video-o3-pro/image-to-video',
}

/** 使用 imageUrls + aspectRatio + resolution 的 modelId（与 v3.1-fast 同格式） */
const RUNNINGHUB_VIDEO_STANDARD_FORMAT_IDS = new Set([
  'rhart-video-v3.1-fast',
  'rhart-video-g',
])

/** 使用 firstImageUrl + lastImageUrl + duration + sound 的 modelId（可灵 o3-pro 首尾帧） */
const RUNNINGHUB_VIDEO_KLING_O3_PRO_IDS = new Set(['kling-video-o3-pro'])

/** 全能视频S-官方（非真人）：输入图须缩放裁剪至 720x1280/1280x720/1024x1792/1792x1024，单张≤10MB */
const RUNNINGHUB_VIDEO_RHART_S_OFFICIAL_IDS = new Set(['rhart-video-s-official-image-to-video'])

/** aspectRatio + resolution → [width, height] */
const RHART_S_OFFICIAL_DIMENSION_MAP: Record<string, [number, number]> = {
  '16:9_720p': [1280, 720],
  '9:16_720p': [720, 1280],
  '16:9_1080p': [1792, 1024],
  '9:16_1080p': [1024, 1792],
}

function getRhartSOfficialTargetDimension(aspectRatio: string, resolution: string): [number, number] {
  const ar = (aspectRatio || '16:9').trim()
  const res = (resolution || '720p').trim().toLowerCase()
  const key = `${ar}_${res}` as keyof typeof RHART_S_OFFICIAL_DIMENSION_MAP
  return RHART_S_OFFICIAL_DIMENSION_MAP[key] ?? [1280, 720]
}

async function prepareImageForRhartVideoSOfficial(
  buffer: Buffer,
  aspectRatio: string,
  resolution: string,
): Promise<Buffer> {
  const [width, height] = getRhartSOfficialTargetDimension(aspectRatio, resolution)
  const MAX_SIZE_BYTES = 10 * 1024 * 1024

  let processed = await sharp(buffer)
    .resize(width, height, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  let quality = 90
  while (processed.length > MAX_SIZE_BYTES && quality > 50) {
    quality -= 5
    processed = await sharp(buffer)
      .resize(width, height, { fit: 'cover', position: 'center' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
  }

  return processed
}

const RHART_S_OFFICIAL_ALLOWED_DIMENSIONS = new Set<string>([
  '720x1280', '1280x720', '1024x1792', '1792x1024',
])

/** 将图片缩放裁剪至允许尺寸，供全能视频S-官方使用。可传 options 或从图片推断。 */
export async function ensureImageSizeForVideoSOfficial(
  base64Image: string,
  options?: { aspectRatio?: string; resolution?: string },
): Promise<string> {
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64Data, 'base64')
  const metadata = await sharp(buffer).metadata()
  const w = metadata.width ?? 0
  const h = metadata.height ?? 0
  const dimKey = `${w}x${h}`
  if (RHART_S_OFFICIAL_ALLOWED_DIMENSIONS.has(dimKey)) {
    return base64Image
  }

  let aspectRatio: string
  let resolution: string
  if (options?.aspectRatio?.trim() && options?.resolution?.trim()) {
    aspectRatio = options.aspectRatio.trim()
    resolution = options.resolution.trim().toLowerCase()
    resolution = resolution === '1080p' ? '1080p' : '720p'
  } else {
    aspectRatio = w >= h ? '16:9' : '9:16'
    resolution = Math.max(w, h) > 1280 ? '1080p' : '720p'
  }

  const processed = await prepareImageForRhartVideoSOfficial(buffer, aspectRatio, resolution)
  return `data:image/jpeg;base64,${processed.toString('base64')}`
}

function getRunningHubVideoEndpoint(modelId?: string): string {
  const id = (modelId || '').trim()
  return RUNNINGHUB_VIDEO_ENDPOINT_MAP[id] ?? 'rhart-video-s-official/image-to-video-realistic'
}

function normalizeVideoDuration(raw?: string | number): string {
  if (raw === undefined || raw === null) return '4'
  const s = String(raw).trim()
  if (s !== '') return s
  return '4'
}

function normalizeVideoAspectRatio(raw?: string): string {
  const s = (raw || '').trim()
  if (s !== '') return s
  return '16:9'
}

function normalizeVideoResolution(raw?: string): string {
  const s = (raw || '').trim().toLowerCase()
  if (s === '720p' || s === '1080p' || s === '540p' || s === '480p') return s
  return '480p'
}

export class RunningHubVideoGenerator extends BaseVideoGenerator {
  protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params
    const modelId = (options.modelId as string | undefined) || 'rhart-video-s-official-image-to-video-realistic'
    const { apiKey } = await getProviderConfig(userId, 'runninghub')
    const cleanedKey = apiKey.replace(/^Bearer\s+/i, '')
    const logger = createScopedLogger({
      module: 'worker.runninghub-video',
      action: 'runninghub_video_generate',
    })

    let base64 = await imageUrlToBase64(imageUrl)
    const useRhartSOfficial = RUNNINGHUB_VIDEO_RHART_S_OFFICIAL_IDS.has(modelId)
    if (useRhartSOfficial) {
      const aspectRatio = normalizeVideoAspectRatio(options.aspectRatio as string | undefined)
      const resolution = (options.resolution as string | undefined)?.trim().toLowerCase()
      const res = resolution === '1080p' ? '1080p' : '720p'
      base64 = await ensureImageSizeForVideoSOfficial(base64, { aspectRatio, resolution: res })
    }
    const uploadOptions = useRhartSOfficial ? { maxSizeMB: 10 } : (RUNNINGHUB_VIDEO_KLING_O3_PRO_IDS.has(modelId) ? { maxSizeMB: 50 } : undefined)
    const uploadedUrl = await uploadBase64ToRunninghub(base64, cleanedKey, uploadOptions)

    const endpoint = getRunningHubVideoEndpoint(modelId)
    const createTaskUrl = `${RUNNINGHUB_BASE_URL}/openapi/v2/${endpoint}`

    const useKlingO3Pro = RUNNINGHUB_VIDEO_KLING_O3_PRO_IDS.has(modelId)
    const useStandardFormat = RUNNINGHUB_VIDEO_STANDARD_FORMAT_IDS.has(modelId)

    let body: Record<string, unknown>
    if (useKlingO3Pro) {
      const rawDuration = Math.floor(Number(options.duration) || 5)
      const validDurations = [3, 4, 5, 6, 8, 10]
      const durationNum = validDurations.includes(rawDuration) ? rawDuration : 5
      const sound = typeof options.generateAudio === 'boolean' ? options.generateAudio : true
      const lastFrameUrl = options.lastFrameImageUrl as string | undefined
      body = {
        prompt: prompt.trim() || '',
        firstImageUrl: uploadedUrl,
        duration: durationNum,
        sound,
      }
      if (lastFrameUrl) {
        const lastBase64 = await imageUrlToBase64(lastFrameUrl)
        const lastUploadedUrl = await uploadBase64ToRunninghub(lastBase64, cleanedKey, { maxSizeMB: 50 })
        ;(body as Record<string, unknown>).lastImageUrl = lastUploadedUrl
      }
    } else if (useStandardFormat) {
      body = {
        prompt: prompt.trim() || '',
        aspectRatio: normalizeVideoAspectRatio(options.aspectRatio as string | undefined),
        imageUrls: [uploadedUrl],
        resolution: normalizeVideoResolution(options.resolution as string | undefined),
        duration: normalizeVideoDuration(options.duration as string | number | undefined),
      }
    } else {
      body = {
        prompt: prompt.trim() || '',
        duration: normalizeVideoDuration(options.duration as string | number | undefined),
        imageUrl: uploadedUrl,
      }
    }
    logger.info({
      message: 'RunningHub 图生视频请求',
      details: { url: createTaskUrl },
    })

    const taskRes = await axios.post<{ taskId?: string }>(createTaskUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanedKey}`,
      },
    })

    const taskId = taskRes.data.taskId
    if (!taskId) {
      const apiMessage = extractRunningHubErrorMessage(taskRes.data)
      const displayMessage = apiMessage ?? `RunningHub 视频任务创建失败 | url=${createTaskUrl}`
      throw new Error(displayMessage)
    }

    const pollUrl = `${RUNNINGHUB_BASE_URL}/task/openapi/outputs`
    logger.info({ message: 'RunningHub 轮询视频任务结果', details: { url: pollUrl, taskId } })

    const maxAttempts = 400
    const delayMs = 3000

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: { data: RunningHubTaskResponse }
      try {
        res = await axios.post<RunningHubTaskResponse>(pollUrl, {
          taskId,
          apiKey: cleanedKey,
        })
      } catch (error: unknown) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status
          if (status === 504 || status === 502 || status === 503) {
            logger.info({
              message: 'RunningHub 视频轮询暂时失败，将重试',
              details: { url: pollUrl, taskId, status, attempt },
            })
            await new Promise<void>((r) => setTimeout(r, delayMs))
            continue
          }
        }
        throw error
      }

      const { code, msg, data } = res.data
      if (code === 0 && msg === 'success') {
        const fileUrl = data?.[0]?.fileUrl
        if (!fileUrl) {
          return { success: false, error: 'RunningHub 视频任务成功但未返回 fileUrl' }
        }
        return { success: true, videoUrl: fileUrl }
      }
      if (code === 804 || code === 813) {
        await new Promise<void>((r) => setTimeout(r, delayMs))
        continue
      }
      if (code === 805) {
        const reason = extractRunningHubErrorMessage(res.data) ?? '未知原因'
        throw new Error(`RunningHub 视频任务失败: ${reason}`)
      }
      throw new Error(`RunningHub 视频未知状态: code=${code}, msg=${msg}`)
    }

    throw new Error('RunningHub 视频任务轮询超时')
  }
}

