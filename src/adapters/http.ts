export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
