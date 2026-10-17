import { useState } from "react";
import { Button } from "../kit";
import { Modal } from "../ui";

export function RenameModal({
  title,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          const next = name.trim();
          if (!next) return;
          try {
            await onSubmit(next);
            onClose();
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
        <label>
          名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <Button variant="primary" type="submit">
          确定
        </Button>
      </form>
    </Modal>
  );
}
