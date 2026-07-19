import { type } from 'arktype'
import { LogLevel } from '../../config.ts'
import { myLog } from '../../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ConnectorStatus,
  MessageId,
  UserId,
} from '../types.ts'
import { MessageData, MessagesResponse } from './schema.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

type ChannelQuery = {
  msgSeq: string
  anchorId: number
  uid: string
}

export class GoshConnector implements ChatConnector {
  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()

  channelQueryMap: Map<ChannelName, ChannelQuery> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()
  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  userId: string | null = null

  connect(channel: ChannelName): Promise<void> {
    this.channelStatus.set(channel, {
      channel,
      status: 'connecting',
      uptimeMs: 0,
      messagesCount: 0,
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      joinedAtStr: Temporal.Now.instant().toString(),
    })
    // TODO find channel id
    return Promise.resolve()
  }

  disconnect(channel: ChannelName): void {
    this.channelStatus.delete(channel)
  }

  cleanup(): void {
    const now = Temporal.Now.instant()
    const disconnectCutoff = now.subtract(
      Temporal.Duration.from({ minutes: 30 }),
    )
    this.log(LogLevel.VERBOSE, `Cleaning up channels`)
    for (const [channel, storage] of this.messages.entries()) {
      if (Temporal.Instant.compare(storage.lastReadAt, disconnectCutoff) < 0) {
        this.disconnect(channel)
      } else {
        storage.clearOldMessages()
      }
    }
  }

  getChannelStatus(
    channel: ChannelName,
  ): ChannelStatus | null {
    const status = this.channelStatus.get(channel)
    if (status) {
      status.messagesCount = this.messages.get(channel)?.count() || 0
      status.uptimeMs = Temporal.Now.instant().epochMilliseconds -
        status.joinedAtMs
    }
    return status || null
  }

  getMessages(
    channel: ChannelName,
    tsFrom: number,
  ): ChatMessage[] {
    const storage = this.messages.get(channel)
    if (!storage) {
      return []
    }
    return storage.getMessagesAfter(tsFrom)
  }

  getStatus(): ConnectorStatus {
    return {
      server: 'gosh',
      status: 'connected',
      startedAtMs: 0,
      startedAtStr: '',
      uptimeMs: 0,
      channels: Array.from(this.channelStatus.values()),
    }
  }

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[gosh]', ...msgs)
  }

  async pollMessages() {
    if (this.channelStatus.size === 0) {
      return
    }
    const channels = this.channelStatus.values()
    await Promise.all(
      Array.from(channels).map((channelStatus) =>
        this.fetchMessages(channelStatus.channel)
      ),
    )
  }

  async fetchMessages(channel: ChannelName) {
    const params = this.channelQueryMap.get(channel)
    if (!params) {
      this.log(LogLevel.DEBUG, 'Channel not found', channel)
      return
    }

    const nowTs = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000)

    const url =
      `https://gosh.com/gosh_fe_api/gosh_3rdimlive/app/group_chat/fetch_msg?app=kick&ch=website&uid=${params.uid}&ts=${nowTs}`

    const resp = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        anchor_id: params.anchorId,
        msg_seq: params.msgSeq,
      }),
    })
    const data = await resp.json()

    const parsed = MessagesResponse(data)
    if (parsed instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        'Failed to parse messages response',
        parsed.issues,
      )
      return
    }

    if (parsed.code !== 0) {
      this.log(LogLevel.DEBUG, 'Failed to fetch messages', parsed)
      return
    }

    if ('data' in parsed) {
      let storage = this.messages.get(channel)
      if (!storage) {
        storage = new MessageStorage()
        this.messages.set(channel, storage)
      }

      const status = this.channelStatus.get(channel)
      if (status) {
        status.status = 'connected'
      }

      for (const msg of parsed.data.msgs) {
        const msgData = MessageData(msg.payload.data)

        if (msgData instanceof type.errors) {
          this.log(
            LogLevel.DEBUG,
            'Failed to parse message data',
            msgData.issues,
          )
          continue
        }

        const message: ChatMessage = {
          server: 'gosh',
          channel,
          id: msgData.msg_id.toString() as MessageId,
          text: msgData.data.text,
          timestampMs: msgData.occur_at * 1000,
          user: {
            id: msgData.user.id.toString() as UserId,
            displayName: msgData.user.nickname,
          },
        }
        storage.addMessage(message)
        params.msgSeq = msg.sequence.toString()
      }
    }
  }

  async doLogin() {
    // todo fetch user info to do api requests
  }
}
