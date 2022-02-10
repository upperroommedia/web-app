import Image from "next/image";
import styles from "../styles/Home.module.css";

const Footer = () => {
  return (
    <footer className={styles.footer}>
      <a>
        Powered by{" "}
        <span className={styles.logo}>
          <Image src="/coptic-devs-logo.webp" alt="Coptic Devs Logo" width="100%" height="100%" />
        </span>
      </a>
    </footer>
  );
};

export default Footer;
