class Logout{
    get Logout() {return $("//div[text()='Account Settings']")}
    get Logout_button() {return $("//span[text()='Log Out']")}
   // get login_button() {return $('#u_0_b')}
    
    }
    
    module.exports=new Logout()