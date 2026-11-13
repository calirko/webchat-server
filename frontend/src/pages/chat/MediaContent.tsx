import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import ImageViewer from '../../components/ImageViewer';
import { api } from '../../lib/api';
import type { ChatMsg } from '../../lib/chatModel';

function toDataUrl(resp: Record<string, any>, fallbackMime: string): string | null {
  const b64 = resp?.base64 ?? resp?.media ?? resp?.data?.base64;
  if (!b64) return null;
  if (String(b64).startsWith('data:')) return String(b64);
  const mime = resp?.mimetype ?? resp?.mediaType ?? fallbackMime ?? 'application/octet-stream';
  return `data:${mime};base64,${b64}`;
}

/**
 * Renders a message's media via the backend decrypt endpoint (/api/media).
 * Images, stickers and voice notes load automatically; videos and documents
 * load on demand (they can be large).
 */
export default function MediaContent({ msg }: { msg: ChatMsg }) {
  const auto = msg.type === 'image' || msg.type === 'sticker' || msg.type === 'audio';
  const [wanted, setWanted] = useState(auto);
  const [zoomed, setZoomed] = useState(false);

  const media = useQuery({
    queryKey: ['media', msg.id],
    queryFn: () =>
      api.media({ key: { id: msg.id, remoteJid: msg.remoteJid, fromMe: msg.fromMe } }),
    enabled: wanted,
    staleTime: Infinity,
    retry: 1,
  });

  const url = media.data ? toDataUrl(media.data, msg.mimetype) : null;

  if (!wanted) {
    return (
      <button
        onClick={() => setWanted(true)}
        className="rounded-md bg-black/5 px-3 py-2 text-xs text-gray-600 hover:bg-black/10"
      >
        {msg.type === 'video' ? '🎥 Load video' : `📄 Load ${msg.fileName || 'document'}`}
      </button>
    );
  }
  if (media.isLoading)
    return <div className="px-2 py-3 text-xs text-gray-400">Loading {msg.type}…</div>;
  if (media.isError || !url)
    return (
      <button
        onClick={() => void media.refetch()}
        className="px-2 py-1 text-xs text-red-400 hover:underline"
      >
        Media unavailable — retry
      </button>
    );

  switch (msg.type) {
    case 'image':
    case 'sticker':
      return (
        <>
          <img
            src={url}
            alt={msg.caption || msg.type}
            onClick={msg.type === 'image' ? () => setZoomed(true) : undefined}
            className={
              msg.type === 'sticker'
                ? 'h-28 w-28 object-contain'
                : 'max-h-72 max-w-full cursor-zoom-in rounded-md'
            }
          />
          {zoomed && (
            <ImageViewer
              url={url}
              alt={msg.caption || 'image'}
              download={msg.fileName || 'image'}
              onClose={() => setZoomed(false)}
            />
          )}
        </>
      );
    case 'audio':
      return <audio controls src={url} className="max-w-60" />;
    case 'video':
      return <video controls src={url} className="max-h-72 max-w-full rounded-md" />;
    default:
      return (
        <a
          href={url}
          download={msg.fileName || 'document'}
          className="text-xs text-blue-600 underline"
        >
          📄 {msg.fileName || 'Download document'}
        </a>
      );
  }
}
