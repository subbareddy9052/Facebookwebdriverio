//  const Screenshot=require('../Test/Pages/screenshot.js');
class Login{
    
    get usernamee() {
    try {
        return $("//input[@id='email']")

    }catch(err) {
        // Screenshot.
        
        console.log("Exception is :"+err);
    }
}
    get passwordd() {
        try{
        return $("//input[@id='pass']")
    }catch(err) {
        // Screenshot.Facebookscreenshot()
        console.log("Exception is :"+err);
    }
}
    get login_button() {
        try{
        return $("//input[@id='u_0_b']")
    }catch(err) {
        // Screenshot.Facebookscreenshot
        console.log("Exception is :"+err);
    }
    }
    
    
} 


    module.exports=new Login()