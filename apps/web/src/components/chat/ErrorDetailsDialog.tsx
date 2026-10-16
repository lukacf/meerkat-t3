import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export function ErrorDetailsDialog({
  details,
  description,
}: {
  details: string;
  description?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<InlineButton />}>Error details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Error details</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          <div className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
            {details}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
