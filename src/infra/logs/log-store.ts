export interface LogStore {
  write(taskId: string, message: string): Promise<void>;
  cleanupExpired(): Promise<void>;
}
