export interface StoredSubmission {
  tick: number;
  key: string;
  body: string;
}

export type WorkerQueueMessage = StoredSubmission;
