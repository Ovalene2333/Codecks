import { useEffect, useState } from "react";
import { ChevronRight, Folder, Home, ArrowUp } from "lucide-react";
import { api } from "./api";
import { Modal } from "./ui";

interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string }[];
}

export function DirBrowser({
  initialPath,
  onClose,
  onSelect,
}: {
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing>();
  const [error, setError] = useState("");
  const load = (target?: string) => {
    setError("");
    const query =
      target === undefined
        ? "/fs"
        : `/fs?path=${encodeURIComponent(target)}`;
    api<DirListing>(query)
      .then(setListing)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load(initialPath || undefined);
  }, [initialPath]);
  return (
    <Modal title="选择工作目录" onClose={onClose}>
      <div className="dir-browser">
        <div className="dir-toolbar">
          <button
            type="button"
            className="icon-btn"
            disabled={!listing || listing.parent === null}
            onClick={() => listing && load(listing.parent ?? "")}
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => listing && load(listing.home)}
          >
            <Home />
          </button>
          <code title={listing?.path}>{listing?.path || "此电脑"}</code>
        </div>
        <div className="dir-list">
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => load(entry.path)}
            >
              <Folder />
              <span>{entry.name}</span>
              <ChevronRight />
            </button>
          ))}
          {listing && !listing.entries.length && (
            <p className="empty-list">这个目录下没有子文件夹</p>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        <button
          className="primary"
          type="button"
          disabled={!listing?.path}
          onClick={() => listing?.path && onSelect(listing.path)}
        >
          使用此目录
        </button>
      </div>
    </Modal>
  );
}
