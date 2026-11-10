// The lockup: the Farad mark, FARAD in Archivo (display) and HALL beside it in Inter Thin, on its
// baseline, as the Orquestra does with ORQUESTRA. HALL is a proper name: never translated.
import logo from './logo.svg';

export const PRODUCT = 'Farad Hall';

export function Lockup({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <div className="lockup">
      <img src={logo} width={lg ? 34 : 26} height={lg ? 34 : 26} alt="" />
      <span className="lockup-words">
        <span className="wordmark" style={{ fontSize: lg ? 'var(--text-2xl)' : 'var(--text-lg)' }}>
          FARAD
        </span>
        <span className="product" style={{ fontSize: lg ? 'var(--text-xl)' : 'var(--text-md)' }}>
          Hall
        </span>
      </span>
    </div>
  );
}
