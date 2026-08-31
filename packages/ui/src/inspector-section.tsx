import { useId } from "react";

export interface InspectorRow {
  readonly term: string;
  readonly value?: string | number;
}

export interface InspectorSectionProps {
  readonly title: string;
  readonly rows: readonly InspectorRow[];
}

const NOT_RECORDED = "Not recorded";

/**
 * A labelled section wrapping a definition list of term/value rows. An
 * absent value (`undefined`) renders the literal "Not recorded" text — a
 * first-class state, distinct from an empty string or a real `0`, both of
 * which are present values and render as themselves.
 */
export function InspectorSection({ title, rows }: InspectorSectionProps) {
  const headingId = useId();

  return (
    <section className="as-inspector-section" aria-labelledby={headingId}>
      <h3 id={headingId} className="as-inspector-section__title">
        {title}
      </h3>
      <dl className="as-inspector-section__list">
        {rows.map((row) => (
          <div className="as-inspector-section__row" key={row.term}>
            <dt className="as-inspector-section__term">{row.term}</dt>
            <dd className="as-inspector-section__value">
              {row.value === undefined ? NOT_RECORDED : row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
