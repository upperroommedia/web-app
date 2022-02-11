/**
 * Navbar: located at the top of all pages
 */
import React, { FunctionComponent } from "react";
import Link from "next/link";
import Image from "next/image";
import styles from "../styles/Home.module.css";

const Navbar: FunctionComponent = () => {
  return (
    <nav>
      <div className={styles.navbar}>
        <h1 className={styles.title}>Upper Room Media</h1>
        <Image
          src="/upper_room_media_icon.png"
          alt="Upper Room Media Logo"
          width="100%"
          height="100%"
        />
      </div>
      <Link href="/">
        <a className={styles.nav_link}>Home</a>
      </Link>
      <Link href="/sermons">
        <a className={styles.nav_link}>Sermons</a>
      </Link>
      <Link href="/about">
        <a className={styles.nav_link}>About</a>
      </Link>
      <Link href="/uploader">
        <a className={styles.nav_link}>Uploader</a>
      </Link>
    </nav>
  );
}

export default Navbar;
