import axios from 'axios'

async function main() {
  const apiKey = process.env.RUNNINGHUB_API_KEY
  if (!apiKey) {
    console.error('请先在环境变量 RUNNINGHUB_API_KEY 中配置 RunningHub 的 API Key。')
    process.exit(1)
  }

  const cleanedKey = apiKey.replace(/^Bearer\s+/i, '')

  const prompt =
    '一幅精美的明代国漫风格插画。一位穿着飞鱼服的锦衣卫站在古老的城墙上，俯瞰着繁华的京城夜景。' +
    '画面采用平涂风格，线条硬朗，色彩对比强烈，背景有灯笼的光晕和几缕薄雾。'

  console.log('1) 创建 nanobanana 任务...')

  const createRes = await axios.post(
    'https://www.runninghub.cn/openapi/v2/rhart-image-n-g31-flash/text-to-image',
    {
      prompt,
      resolution: '1k',
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cleanedKey}`,
      },
    },
  )

  const taskId = (createRes.data as { taskId?: string }).taskId
  if (!taskId) {
    console.error('任务创建失败：', JSON.stringify(createRes.data, null, 2))
    process.exit(1)
  }

  console.log('任务已创建，taskId =', taskId)
  console.log('2) 开始轮询任务结果...')

  const maxAttempts = 60
  const delayMs = 3000

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await axios.post(
      'https://www.runninghub.cn/task/openapi/outputs',
      {
        taskId,
        apiKey: cleanedKey,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )

    const { code, msg, data } = res.data as {
      code: number
      msg: string
      data?: Array<{ fileUrl?: string; failedReason?: { exception_message?: string } }>
    }

    console.log(`第 ${attempt} 次轮询：code=${code}, msg=${msg}`)

    if (code === 0 && msg === 'success') {
      const url = data?.[0]?.fileUrl
      if (!url) {
        console.error('任务成功但未返回 fileUrl：', JSON.stringify(res.data, null, 2))
        process.exit(1)
      }
      console.log('✅ 任务成功，图片地址：', url)
      return
    }

    if (code === 804 || code === 813) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), delayMs)
      })
      continue
    }

    if (code === 805) {
      const reason = data?.[0]?.failedReason?.exception_message ?? '未知原因'
      console.error('❌ 任务失败：', reason)
      process.exit(1)
    }

    console.error('❌ 未知状态：', JSON.stringify(res.data, null, 2))
    process.exit(1)
  }

  console.error(`❌ 轮询超时（${(maxAttempts * delayMs) / 1000} 秒仍未完成）`)
  process.exit(1)
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error: unknown) => {
  console.error('执行脚本时发生错误：', error)
  process.exit(1)
})

