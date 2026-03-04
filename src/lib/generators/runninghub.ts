import axios from 'axios'
import FormData from 'form-data'
import sharp from 'sharp'
import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from './base'
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

const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn'

/** modelId → 接口路径（无前导 /openapi/v2/） */
const RUNNINGHUB_MODEL_PATH_MAP: Record<string, string> = {
  'rhart-image-n-g31-flash': 'rhart-image-n-g31-flash',
  'rhart-image-n-g31-flash-official': 'rhart-image-n-g31-flash-official',
  'rhart-image-n-g31-flash-image-to-image': 'rhart-image-n-g31-flash',
  'rhart-image-n-g31-flash-official-image-to-image': 'rhart-image-n-g31-flash-official',
}

/** 使用 image-to-image 接口的 modelId（图生图）；其余有参考图时用 edit */
const RUNNINGHUB_IMAGE_TO_IMAGE_MODEL_IDS = new Set<string>([
  'rhart-image-n-g31-flash-image-to-image',
  'rhart-image-n-g31-flash-official-image-to-image',
])

function getRunningHubModelPath(modelId?: string): string {
  const id = (modelId || '').trim()
  return RUNNINGHUB_MODEL_PATH_MAP[id] || 'rhart-image-n-g31-flash'
}

function useImageToImageEndpoint(modelId?: string): boolean {
  return RUNNINGHUB_IMAGE_TO_IMAGE_MODEL_IDS.has((modelId || '').trim())
}

function normalizeResolution(raw?: string): string {
  const value = (raw || '').trim().toLowerCase()
  if (value === '1k' || value === '2k' || value === '4k') return value
  if (value === '0.5k') return '1k'
  return '1k'
}

async function uploadBase64ToRunninghub(base64Image: string, apiKey: string): Promise<string> {
  const cleanedKey = apiKey.replace(/^Bearer\s+/i, '')
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '')
  let buffer = Buffer.from(base64Data, 'base64')

  const MAX_SIZE_BYTES = 7 * 1024 * 1024
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

    const modelPath = getRunningHubModelPath(optionsModelId)
    const hasReferenceImages = imageUrls.length > 0
    const refEndpoint = useImageToImageEndpoint(optionsModelId) ? 'image-to-image' : 'edit'
    const endpoint = hasReferenceImages
      ? `/openapi/v2/${modelPath}/${refEndpoint}`
      : `/openapi/v2/${modelPath}/text-to-image`

    const createTaskUrl = `${RUNNINGHUB_BASE_URL}${endpoint}`
    logger.info({
      message: 'RunningHub nanobanana 请求',
      details: {
        url: createTaskUrl,
        endpoint,
        hasReferenceImages,
        resolution: resolution ?? null,
        aspectRatio: aspectRatio ?? null,
      },
    })

    const body: Record<string, unknown> = {
      prompt,
      resolution: normalizeResolution(resolution),
    }
    if (aspectRatio != null && aspectRatio !== '') {
      body.aspectRatio = aspectRatio
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
      const errDetail = JSON.stringify(taskRes.data)
      throw new Error(
        `RunningHub 任务创建失败: ${errDetail} | url=${createTaskUrl} | modelId=${optionsModelId ?? '(未传)'}`,
      )
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
        const reason = data?.[0]?.failedReason?.exception_message ?? '未知原因'
        throw new Error(`RunningHub 任务失败: ${reason}`)
      }

      throw new Error(`RunningHub 未知状态: code=${code}, msg=${msg}`)
    }

    throw new Error('RunningHub 任务轮询超时')
  }
}

