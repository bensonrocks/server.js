const PHOTOS = [
  {
    src: "/gallery/gallery-racking-wide.jpg",
    caption: "Pallet racking and inbound staging",
  },
  {
    src: "/gallery/gallery-racking-aisle.jpg",
    caption: "High-density pallet storage",
  },
  {
    src: "/gallery/gallery-kitting-1.jpg",
    caption: "Kitting and bundling in progress",
  },
  {
    src: "/gallery/gallery-kitting-2.jpg",
    caption: "Retail packaging, ready for dispatch",
  },
  {
    src: "/gallery/gallery-outbound-single.jpg",
    caption: "Outbound parcel, ready for courier collection",
  },
  {
    src: "/gallery/gallery-outbound-batch.jpg",
    caption: "Batched outbound parcels",
  },
];

export function FacilityGallery() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20">
      <div className="max-w-2xl">
        <span className="text-xs font-bold uppercase tracking-wider text-brand">
          Inside the facility
        </span>
        <h2 className="mt-3 font-display text-4xl font-bold text-ink">
          A look at the floor.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          Storage, kitting, and dispatch at our Singapore facility.
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {PHOTOS.map((photo) => (
          <figure
            key={photo.src}
            className="overflow-hidden rounded-lg border border-border bg-paper-alt"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.src}
              alt={photo.caption}
              className="aspect-[4/3] w-full object-cover"
              loading="lazy"
            />
            <figcaption className="px-4 py-3 text-sm text-ink-muted">
              {photo.caption}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
