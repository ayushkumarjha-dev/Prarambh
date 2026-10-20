import logo from "@/assets/favicon-source.png";

/**
 * The original Prarambh logo (the app-icon artwork). Rendered as a decorative
 * image — surrounding links/labels carry the accessible name.
 * The artwork has a light padding ring around the green tile, so it is
 * slightly scaled up inside an overflow-hidden rounded frame to let the
 * tile itself fill the box.
 */
export function LogoMark({ className = "size-9 rounded-xl" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`block shrink-0 overflow-hidden ${className}`}>
      <img src={logo} alt="" className="h-full w-full scale-[1.36] object-cover" />
    </span>
  );
}
