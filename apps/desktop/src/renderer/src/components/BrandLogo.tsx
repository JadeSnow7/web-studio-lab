import logo from '../../../../resources/branding/logo.svg';
import smallLogo from '../../../../resources/branding/logo-small.svg';

/** Decorative where the surrounding title already identifies the application or page. */
export function BrandLogo({ size }: { size: 24 | 64 }) {
  return <img className="brand-logo" src={size === 24 ? smallLogo : logo} width={size} height={size} alt="" draggable={false} />;
}
