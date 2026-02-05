export interface ImportResponse {
  results: Array<{
    ok: boolean
    error?: string
    id?: number
    external_id?: string
  }>
}

export interface OdooRPCError {
  code: number
  message: string
  data: {
    name: string
    message: string
    arguments: string[]
    debug: string
  }
}
