declare module "update-notifier" {
  export interface UpdateNotifierOptions {
    pkg: {
      name: string;
      version: string;
    };
    updateCheckInterval?: number;
    shouldNotifyInNpmScript?: boolean;
    distTag?: string;
  }

  export interface UpdateInfo {
    latest: string;
    current: string;
    type?: string;
    name: string;
  }

  export interface UpdateNotifierConfigStore {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  }

  export interface UpdateNotifierInstance {
    update?: UpdateInfo;
    config?: UpdateNotifierConfigStore;
    fetchInfo(): Promise<UpdateInfo>;
  }

  export default function updateNotifier(options: UpdateNotifierOptions): UpdateNotifierInstance;
}
