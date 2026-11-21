import tilliLogo from '../../assets/tilli-logo.png';

/** The official Tilli logo with the brand gradient line, at the top of the sign-in cards. */
export default function AuthBrand() {
  return (
    <div className="-mx-8 -mt-8 mb-6">
      <div className="h-1 rounded-t-card bg-brand-gradient" aria-hidden="true" />
      <div className="flex justify-center pt-7">
        <img src={tilliLogo} alt="Tilli" className="h-9 w-auto" width={79} height={36} />
      </div>
    </div>
  );
}
