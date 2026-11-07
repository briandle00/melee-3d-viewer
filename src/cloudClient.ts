import { ReplayStub } from "~/state/selectionStore";

// This viewer never fetches replays from or sends them to any server (Slippi
// Lab's share service included), so the cloud calls are inert.
export async function downloadReplay(
  name: string
): Promise<{ data: Blob | null; error: Error | null }> {
  return { data: null, error: new Error(`${name}: no cloud replays in this viewer`) };
}

export async function loadFromCloud(
  name: string,
  load?: (files: File[]) => Promise<void>
): Promise<File> {
  const { data, error } = await downloadReplay(name);
  if (data != null) {
    const file = new File([data], name);
    if (load !== undefined) {
      await load([file]);
    }
    return file;
  } else {
    throw error;
  }
}

export async function listCloudReplays(): Promise<ReplayStub[]> {
  // no cloud library
  return [];
}
