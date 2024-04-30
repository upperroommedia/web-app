export type FunctionOutputType<T> = { status: 'success'; data: T } | { status: 'error'; error: string };
