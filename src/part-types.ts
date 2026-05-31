export interface TextPart {
  type: "text"
  id: string
  sessionID: string
  messageID: string
  text: string
}

export type AppPart = TextPart
