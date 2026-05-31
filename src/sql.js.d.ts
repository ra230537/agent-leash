declare module "sql.js" {
  interface QueryExecResult {
    columns: string[]
    values: any[][]
  }

  class Database {
    constructor(data?: ArrayLike<number> | Buffer | null)
    run(sql: string, params?: any[]): Database
    exec(sql: string, params?: any[]): QueryExecResult[]
    export(): Uint8Array
    close(): void
  }

  function initSqlJs(): Promise<{
    Database: typeof Database
  }>

  export default initSqlJs
}
