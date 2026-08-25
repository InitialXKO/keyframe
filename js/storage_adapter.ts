import { OPFSStorage } from "./opfs_storage.js";

export class StorageAdapter {
  private opfs: OPFSStorage = new OPFSStorage();

  public async saveIR(key: string, irObject: any): Promise<void> {
    const jsonStr = JSON.stringify(irObject);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonStr);
    await this.opfs.write(key, bytes);
  }

  public async loadIR(key: string): Promise<any> {
    const bytes = await this.opfs.read(key);
    const decoder = new TextDecoder();
    const jsonStr = decoder.decode(bytes);
    return JSON.parse(jsonStr);
  }

  public async saveBakeData(key: string, bakeBytes: Uint8Array): Promise<void> {
    await this.opfs.write(key, bakeBytes);
  }

  public async loadBakeData(key: string): Promise<Uint8Array> {
    return await this.opfs.read(key);
  }
}
