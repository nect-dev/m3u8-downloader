import fs from 'fs';

interface Segment {
  duration: number;
  url: string;
}

interface DownloadProgress {
  chunk: Uint8Array;
  progress: number;
}

class HLSDownloader {
  private baseUrl: string;
  private segments: Segment[] = [];
  private totalSegments: number = 0;
  private readonly concurrentLimit: number;

  constructor(private m3u8Url: string, concurrentLimit = 5) {
    this.baseUrl = this.getBaseUrl(m3u8Url);
    this.concurrentLimit = concurrentLimit;
  }

  private getBaseUrl(url: string): string {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1)}`;
  }

  private async fetchWithRetry(url: string, retryCount = 3): Promise<Response> {
    let lastError;
    for (let i = 0; i < retryCount; i++) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response;
      } catch (error) {
        console.error(`Retry ${i + 1}/${retryCount} failed for URL: ${url}`);
        lastError = error;
        if (i < retryCount - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    }
    throw lastError;
  }

  private async parseM3U8(content: string): Promise<void> {
    const lines = content.split('\n');
    let duration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith('#')) {
          const playlistUrl = nextLine.startsWith('http') ? nextLine : this.baseUrl + nextLine;
          const response = await this.fetchWithRetry(playlistUrl);
          const subContent = await response.text();
          return this.parseM3U8(subContent);
        }
      } else if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.split(':')[1].split(',')[0]);
        const nextLine = lines[i + 1]?.trim();

        if (nextLine && !nextLine.startsWith('#')) {
          const url = nextLine.startsWith('http') ? nextLine : this.baseUrl + nextLine;
          this.segments.push({ duration, url });
        }
      }
    }

    this.totalSegments = this.segments.length;
  }

  private async downloadSegment(segment: Segment, index: number): Promise<DownloadProgress> {
    const response = await this.fetchWithRetry(segment.url);
    const buffer = await response.arrayBuffer();
    const chunk = new Uint8Array(buffer);
    const progress = ((index + 1) / this.totalSegments) * 100;
    return { chunk, progress };
  }

  async *download(): AsyncGenerator<DownloadProgress, void, unknown> {
    const response = await this.fetchWithRetry(this.m3u8Url);
    const content = await response.text();
    await this.parseM3U8(content);

    if (this.segments.length === 0) {
      throw new Error('No segments found in m3u8');
    }

    for (let i = 0; i < this.segments.length; i += this.concurrentLimit) {
      const batch = this.segments.slice(i, i + this.concurrentLimit);
      const downloadPromises = batch.map((segment, batchIndex) =>
        this.downloadSegment(segment, i + batchIndex)
      );

      const results = await Promise.all(downloadPromises);
      for (const result of results) {
        yield result;
      }
    }
  }
}

async function runDownload(url: string, filename: string = 'video.m3u8'): Promise<void> {
  try {
    const downloader = new HLSDownloader(url);
    const writeStream = fs.createWriteStream(filename);

    for await (const { chunk, progress } of downloader.download()) {
      writeStream.write(chunk);
      console.log(`${progress.toFixed(2)}%`);
    }

    writeStream.end();
    console.log(`Download complete: ${filename}`);
  } catch (error) {
    console.error('Error occurred:', error);
  }
}

runDownload("https://example.com/video.m3u8");
