/**
 * Navbar: located at the top of all pages
 */
import { FunctionComponent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import styles from '../styles/Navbar.module.css';
import useAuth from '../context/user/UserContext';
import ImageUploader from './ImageUploader';

const Navbar: FunctionComponent = () => {
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email;
  const photoSrc = user?.photoURL || '/user.png';
  return (
    <nav>
      <ImageUploader />
      <div className={styles.navbar}>
        <div className={styles.navbar_header_container}>
          <h1 className={styles.title}>Upper Room Media</h1>
          <Image src="/upper_room_media_icon.png" alt="Upper Room Media Logo" width="100%" height="100%" />
        </div>
        {user && (
          <div className={styles.user_info}>
            <div className={styles.profile_pic}>
              <Image src={photoSrc} layout="fill" alt="User profile picture"></Image>
            </div>
            <p>{displayName}</p>
          </div>
        )}
      </div>
      <div className={styles.navbar_links}>
        <Link href="/">
          <a className={styles.nav_link}>Home</a>
        </Link>
        <Link href="/sermons">
          <a className={styles.nav_link}>Sermons</a>
        </Link>
        <Link href="/about">
          <a className={styles.nav_link}>About</a>
        </Link>

        {!user ? (
          <>
            <Link href="/login">
              <a className={styles.nav_link}>Login</a>
            </Link>
            <Link href="/signup">
              <a className={styles.nav_link}>Sign Up</a>
            </Link>
          </>
        ) : (
          // All Pages that need to be protected
          <>
            {user?.role === 'admin' ? (
              <>
                <Link href="/uploader">
                  <a className={styles.nav_link}>Uploader</a>
                </Link>
                <Link href="/admin">
                  <a className={styles.nav_link}>Admin</a>
                </Link>
              </>
            ) : (
              <></>
            )}
            <Link href="/logout">
              <a className={styles.nav_link}>Log out</a>
            </Link>
          </>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
