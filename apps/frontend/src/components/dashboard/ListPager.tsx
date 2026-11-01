import { Button } from "@/components/ui/button";
import type { Pagination } from "@/lib/api/pagination";

/** Prev/next controls driven by the API's pagination block. Renders nothing for a single page. */
const ListPager = ({ pagination, onPageChange, disabled }: {
  pagination?: Pagination;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) => {
  if (!pagination || pagination.pages <= 1) return null;
  const { page, pages, total } = pagination;
  return (
    <div className="flex items-center justify-between py-3 text-sm text-muted-foreground">
      <span>Page {page} of {pages} · {total} total</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || page >= pages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
};

export default ListPager;
