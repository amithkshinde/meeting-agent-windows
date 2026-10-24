interface Window {
  api: {
    invoke(channel: string, ...args: any[]): Promise<any>;
    send(channel: string, ...args: any[]): void;
    on(channel: string, fn: (...args: any[]) => void): void;
  };
  __startFromMain?: (app: string, title: string) => void;
  __stopFromMain?: () => void;
  __bookmarkFromMain?: () => void;
}
