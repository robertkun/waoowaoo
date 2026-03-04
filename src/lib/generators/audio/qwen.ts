/**
 * 阿里百炼语音生成器
 * 
 * 支持：
 * - Qwen TTS
 */

import { BaseAudioGenerator, AudioGenerateParams, GenerateResult } from '../base'
import { getProviderConfig } from '@/lib/api-config'
import { logInfo as _ulogInfo } from '@/lib/logging/core'

const QWEN_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/audio/tts'

export class QwenTTSGenerator extends BaseAudioGenerator {
    protected async doGenerate(params: AudioGenerateParams): Promise<GenerateResult> {
        const { userId, text, voice = 'default', rate = 1.0 } = params

        const { apiKey } = await getProviderConfig(userId, 'qwen')

        const body = {
            text,
            voice,
            rate
        }

        _ulogInfo(`[Qwen TTS] 请求, url: ${QWEN_TTS_URL}`)

        // 调用阿里百炼 TTS API
        const response = await fetch(QWEN_TTS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Qwen TTS 失败 (${response.status}): ${errorText}`)
        }

        const data = await response.json()
        const audioUrl = data.audio_url || data.output?.audio_url

        if (!audioUrl) {
            throw new Error('Qwen 未返回音频 URL')
        }

        return {
            success: true,
            audioUrl
        }
    }
}
